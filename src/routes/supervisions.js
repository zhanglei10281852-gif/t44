const { Router } = require("express");
const { pool } = require("../db");
const { getTimeLimitRule } = require("./timeLimitRules");
const {
  countWorkdays,
  countNaturalDays,
  formatDate,
} = require("../utils/workday");
const router = Router();

function getCurrentStage(caseItem) {
  switch (caseItem.status) {
    case "待审批":
      return { stage: "审批", startDate: caseItem.created_at };
    case "已批准":
      return { stage: "指派", startDate: caseItem.approved_at };
    case "已指派":
    case "办理中":
      return {
        stage: "办理",
        startDate: caseItem.started_at || caseItem.assigned_at,
      };
    default:
      return null;
  }
}

async function calculateCaseOvertime(caseItem) {
  const stageInfo = getCurrentStage(caseItem);
  if (!stageInfo || !stageInfo.startDate) return null;

  const rule = await getTimeLimitRule(stageInfo.stage, caseItem.case_type);
  if (!rule) return null;

  const now = new Date();
  const limitDays = caseItem.special_deadline || rule.days;
  const unit = rule.unit;

  let usedDays, totalDays;
  if (unit === "工作日") {
    usedDays = await countWorkdays(stageInfo.startDate, now);
    totalDays = limitDays;
  } else {
    usedDays = countNaturalDays(stageInfo.startDate, now);
    totalDays = limitDays;
  }

  const remainingDays = totalDays - usedDays;
  const ratio = remainingDays / totalDays;

  let warningLevel = "正常";
  if (remainingDays <= 0) {
    warningLevel = "红牌超时";
  } else if (ratio <= 0.2) {
    warningLevel = "黄牌预警";
  }

  return {
    case_id: caseItem.id,
    case_no: caseItem.case_no,
    case_type: caseItem.case_type,
    applicant_name: caseItem.applicant_name,
    lawyer_name: caseItem.lawyer_name,
    status: caseItem.status,
    current_stage: stageInfo.stage,
    limit_days: totalDays,
    used_days: usedDays,
    remaining_days: remainingDays,
    warning_level: warningLevel,
    unit: unit,
  };
}

router.get("/scan", async (req, res) => {
  const [cases] = await pool.execute(`
    SELECT c.*, a.name as applicant_name, l.name as lawyer_name
    FROM cases c
    LEFT JOIN applicants a ON c.applicant_id = a.id
    LEFT JOIN lawyers l ON c.lawyer_id = l.id
    WHERE c.status IN ('待审批', '已批准', '已指派', '办理中')
  `);

  const results = [];
  for (const c of cases) {
    const overtimeInfo = await calculateCaseOvertime(c);
    if (overtimeInfo) {
      results.push(overtimeInfo);
    }
  }

  const warnings = results.filter((r) => r.warning_level !== "正常");
  const yellowCards = warnings.filter((r) => r.warning_level === "黄牌预警");
  const redCards = warnings.filter((r) => r.warning_level === "红牌超时");

  res.json({
    total: results.length,
    warning_count: warnings.length,
    yellow_card_count: yellowCards.length,
    red_card_count: redCards.length,
    list: results,
  });
});

router.get("/warnings", async (req, res) => {
  const { level, page = 1, size = 20 } = req.query;

  const [cases] = await pool.execute(`
    SELECT c.*, a.name as applicant_name, l.name as lawyer_name
    FROM cases c
    LEFT JOIN applicants a ON c.applicant_id = a.id
    LEFT JOIN lawyers l ON c.lawyer_id = l.id
    WHERE c.status IN ('待审批', '已批准', '已指派', '办理中')
  `);

  const allWarnings = [];
  for (const c of cases) {
    const overtimeInfo = await calculateCaseOvertime(c);
    if (overtimeInfo && overtimeInfo.warning_level !== "正常") {
      allWarnings.push(overtimeInfo);
    }
  }

  let filtered = allWarnings;
  if (level) {
    filtered = allWarnings.filter((w) => w.warning_level === level);
  }

  const total = filtered.length;
  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;
  const data = filtered.slice(offset, offset + limit);

  res.json({
    total,
    page: parseInt(page),
    size: limit,
    data,
  });
});

router.post("/", async (req, res) => {
  const { case_id, supervisor, reason, require_date } = req.body;
  if (!case_id || !supervisor || !reason || !require_date) {
    return res
      .status(400)
      .json({ error: "案件ID、督办人、督办原因、要求完成日期为必填" });
  }

  const [[caseItem]] = await pool.execute(
    "SELECT id, status, supervision_count FROM cases WHERE id = ?",
    [case_id],
  );
  if (!caseItem) return res.status(404).json({ error: "案件不存在" });
  if (caseItem.status === "已结案" || caseItem.status === "已驳回") {
    return res.status(400).json({ error: "已结案或已驳回的案件不能督办" });
  }

  const [result] = await pool.execute(
    "INSERT INTO supervisions (case_id, supervisor, reason, require_date) VALUES (?, ?, ?, ?)",
    [case_id, supervisor, reason, require_date],
  );

  const newCount = (caseItem.supervision_count || 0) + 1;
  let isEscalated = false;

  if (newCount >= 2) {
    const [[activeCount]] = await pool.execute(
      "SELECT COUNT(*) as cnt FROM supervisions WHERE case_id = ? AND status != '已解除'",
      [case_id],
    );
    if (activeCount.cnt >= 2) {
      await pool.execute(
        "UPDATE cases SET is_serious_overtime = 1, supervision_count = ? WHERE id = ?",
        [newCount, case_id],
      );
      await pool.execute(
        "UPDATE supervisions SET is_escalated = 1 WHERE id = ?",
        [result.insertId],
      );
      isEscalated = true;
    } else {
      await pool.execute(
        "UPDATE cases SET supervision_count = ? WHERE id = ?",
        [newCount, case_id],
      );
    }
  } else {
    await pool.execute("UPDATE cases SET supervision_count = ? WHERE id = ?", [
      newCount,
      case_id,
    ]);
  }

  res.status(201).json({
    id: result.insertId,
    message: isEscalated
      ? "督办发起成功，已自动升级为严重超时"
      : "督办发起成功",
    is_escalated: isEscalated,
  });
});

router.get("/", async (req, res) => {
  const { case_id, status, is_escalated, page = 1, size = 20 } = req.query;
  let conditions = [];
  let params = [];

  if (case_id) {
    conditions.push("s.case_id = ?");
    params.push(case_id);
  }
  if (status) {
    conditions.push("s.status = ?");
    params.push(status);
  }
  if (is_escalated !== undefined) {
    conditions.push("s.is_escalated = ?");
    params.push(is_escalated);
  }

  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM supervisions s${where}`,
    params,
  );

  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;

  const [data] = await pool.execute(
    `SELECT s.*, c.case_no, c.case_type, a.name as applicant_name, l.name as lawyer_name
     FROM supervisions s
     LEFT JOIN cases c ON s.case_id = c.id
     LEFT JOIN applicants a ON c.applicant_id = a.id
     LEFT JOIN lawyers l ON c.lawyer_id = l.id
     ${where}
     ORDER BY s.created_at DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  res.json({ total, page: parseInt(page), size: limit, data });
});

router.get("/:id", async (req, res) => {
  const [[row]] = await pool.execute(
    `SELECT s.*, c.case_no, c.case_type, c.status as case_status,
            a.name as applicant_name, l.name as lawyer_name
     FROM supervisions s
     LEFT JOIN cases c ON s.case_id = c.id
     LEFT JOIN applicants a ON c.applicant_id = a.id
     LEFT JOIN lawyers l ON c.lawyer_id = l.id
     WHERE s.id = ?`,
    [req.params.id],
  );
  if (!row) return res.status(404).json({ error: "督办记录不存在" });
  res.json(row);
});

router.put("/:id/reply", async (req, res) => {
  const { reply_estimate_date, reply_progress } = req.body;
  if (!reply_estimate_date || !reply_progress) {
    return res.status(400).json({ error: "预计完成日期和当前进展说明为必填" });
  }

  const [[supervision]] = await pool.execute(
    "SELECT id, status FROM supervisions WHERE id = ?",
    [req.params.id],
  );
  if (!supervision) return res.status(404).json({ error: "督办记录不存在" });
  if (supervision.status !== "已发出") {
    return res.status(400).json({ error: "只有已发出状态的督办可以回复" });
  }

  await pool.execute(
    "UPDATE supervisions SET status = '已回复', reply_estimate_date = ?, reply_progress = ?, reply_at = NOW() WHERE id = ?",
    [reply_estimate_date, reply_progress, req.params.id],
  );
  res.json({ message: "督办回复成功" });
});

router.put("/:id/release", async (req, res) => {
  const [[supervision]] = await pool.execute(
    "SELECT id, status, case_id FROM supervisions WHERE id = ?",
    [req.params.id],
  );
  if (!supervision) return res.status(404).json({ error: "督办记录不存在" });
  if (supervision.status === "已解除") {
    return res.status(400).json({ error: "该督办已解除" });
  }

  await pool.execute(
    "UPDATE supervisions SET status = '已解除', resolved_at = NOW() WHERE id = ?",
    [req.params.id],
  );

  const [[caseItem]] = await pool.execute(
    "SELECT status FROM cases WHERE id = ?",
    [supervision.case_id],
  );

  if (
    caseItem &&
    (caseItem.status === "已结案" || caseItem.status === "已驳回")
  ) {
    await pool.execute(
      "UPDATE cases SET is_serious_overtime = 0 WHERE id = ?",
      [supervision.case_id],
    );
  }

  res.json({ message: "督办已解除" });
});

router.post("/:id/reassign", async (req, res) => {
  const { new_lawyer_id, reason } = req.body;
  if (!new_lawyer_id) {
    return res.status(400).json({ error: "新律师ID为必填" });
  }

  const [[supervision]] = await pool.execute(
    "SELECT id, case_id, is_escalated FROM supervisions WHERE id = ?",
    [req.params.id],
  );
  if (!supervision) return res.status(404).json({ error: "督办记录不存在" });
  if (!supervision.is_escalated) {
    return res.status(400).json({ error: "只有升级的督办才能更换律师" });
  }

  const [[caseItem]] = await pool.execute(
    "SELECT id, lawyer_id, status FROM cases WHERE id = ?",
    [supervision.case_id],
  );
  if (!caseItem) return res.status(404).json({ error: "案件不存在" });

  const [[newLawyer]] = await pool.execute(
    "SELECT id, status FROM lawyers WHERE id = ?",
    [new_lawyer_id],
  );
  if (!newLawyer) return res.status(404).json({ error: "新律师不存在" });
  if (newLawyer.status !== "可接案") {
    return res.status(400).json({ error: "该律师当前不可接案" });
  }

  if (caseItem.lawyer_id) {
    await pool.execute("UPDATE lawyers SET status = '可接案' WHERE id = ?", [
      caseItem.lawyer_id,
    ]);
  }

  await pool.execute("UPDATE cases SET lawyer_id = ? WHERE id = ?", [
    new_lawyer_id,
    caseItem.id,
  ]);
  await pool.execute(
    "UPDATE lawyers SET status = '案件中', case_count = case_count + 1 WHERE id = ?",
    [new_lawyer_id],
  );

  await pool.execute(
    "INSERT INTO case_progress (case_id, progress_date, description) VALUES (?, CURDATE(), ?)",
    [caseItem.id, `更换律师，原因：${reason || "严重超时督办升级"}`],
  );

  res.json({ message: "律师更换成功" });
});

router.post("/:id/extend", async (req, res) => {
  const { extra_days, reason } = req.body;
  if (!extra_days || extra_days <= 0) {
    return res.status(400).json({ error: "延期天数必须为正整数" });
  }

  const [[supervision]] = await pool.execute(
    "SELECT id, case_id, is_escalated FROM supervisions WHERE id = ?",
    [req.params.id],
  );
  if (!supervision) return res.status(404).json({ error: "督办记录不存在" });
  if (!supervision.is_escalated) {
    return res.status(400).json({ error: "只有升级的督办才能延期" });
  }

  const [[caseItem]] = await pool.execute(
    "SELECT id, special_deadline FROM cases WHERE id = ?",
    [supervision.case_id],
  );
  if (!caseItem) return res.status(404).json({ error: "案件不存在" });

  const stageInfo = getCurrentStage(caseItem);
  if (!stageInfo) {
    return res.status(400).json({ error: "案件当前阶段无法延期" });
  }

  const rule = await getTimeLimitRule(stageInfo.stage, caseItem.case_type);
  const baseDays = caseItem.special_deadline || rule.days;
  const newDeadline = baseDays + parseInt(extra_days);

  await pool.execute(
    "UPDATE cases SET special_deadline = ?, is_serious_overtime = 0 WHERE id = ?",
    [newDeadline, caseItem.id],
  );

  await pool.execute(
    "UPDATE supervisions SET status = '已解除', resolved_at = NOW() WHERE id = ?",
    [req.params.id],
  );

  await pool.execute(
    "INSERT INTO case_progress (case_id, progress_date, description) VALUES (?, CURDATE(), ?)",
    [
      caseItem.id,
      `案件延期${extra_days}天，原因：${reason || "严重超时督办升级"}`,
    ],
  );

  res.json({ message: "延期成功", new_deadline: newDeadline });
});

module.exports = router;
module.exports.calculateCaseOvertime = calculateCaseOvertime;
module.exports.getCurrentStage = getCurrentStage;
