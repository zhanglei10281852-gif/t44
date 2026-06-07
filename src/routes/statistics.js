const { Router } = require("express");
const { pool } = require("../db");
const { countNaturalDays, countWorkdays } = require("../utils/workday");
const { getTimeLimitRule } = require("./timeLimitRules");
const router = Router();

router.get("/avg-cycle", async (req, res) => {
  const [closedCases] = await pool.execute(`
    SELECT c.id, c.case_type, c.started_at, c.closed_at
    FROM cases c
    WHERE c.status = '已结案' AND c.started_at IS NOT NULL AND c.closed_at IS NOT NULL
  `);

  const typeMap = {};
  for (const c of closedCases) {
    const days = countNaturalDays(c.started_at, c.closed_at);
    if (!typeMap[c.case_type]) {
      typeMap[c.case_type] = { total: 0, count: 0 };
    }
    typeMap[c.case_type].total += days;
    typeMap[c.case_type].count++;
  }

  const result = Object.entries(typeMap).map(([case_type, data]) => ({
    case_type,
    case_count: data.count,
    avg_days:
      data.count > 0 ? Math.round((data.total / data.count) * 10) / 10 : 0,
  }));

  res.json(result);
});

router.get("/overtime-rate", async (req, res) => {
  const [[totalCount]] = await pool.execute(
    "SELECT COUNT(*) as total FROM cases WHERE status != '已驳回'",
  );

  const [allCases] = await pool.execute(`
    SELECT c.*
    FROM cases c
    WHERE c.status != '已驳回'
  `);

  let overtimeCount = 0;
  const stageOvertime = {
    审批: 0,
    指派: 0,
    办理: 0,
  };

  for (const c of allCases) {
    const isOvertime = await checkCaseOvertime(c, stageOvertime);
    if (isOvertime) overtimeCount++;
  }

  res.json({
    total_cases: totalCount.total,
    overtime_cases: overtimeCount,
    overtime_rate:
      totalCount.total > 0
        ? Math.round((overtimeCount / totalCount.total) * 10000) / 100
        : 0,
    stage_detail: stageOvertime,
  });
});

async function checkCaseOvertime(caseItem, stageOvertime) {
  let stage, startDate;

  if (caseItem.status === "待审批" || caseItem.status === "已批准") {
    stage = "审批";
    startDate = caseItem.created_at;
  } else if (caseItem.status === "已指派") {
    stage = "指派";
    startDate = caseItem.approved_at;
  } else if (caseItem.status === "办理中" || caseItem.status === "已结案") {
    stage = "办理";
    startDate = caseItem.started_at;
  } else {
    return false;
  }

  if (!startDate) return false;

  const rule = await getTimeLimitRule(stage, caseItem.case_type);
  if (!rule) return false;

  const endDate =
    caseItem.status === "已结案" ? caseItem.closed_at : new Date();
  const limitDays = caseItem.special_deadline || rule.days;

  let usedDays;
  if (rule.unit === "工作日") {
    usedDays = await countWorkdays(startDate, endDate);
  } else {
    usedDays = countNaturalDays(startDate, endDate);
  }

  const isOvertime = usedDays > limitDays;
  if (isOvertime && stageOvertime) {
    stageOvertime[stage]++;
  }

  return isOvertime;
}

router.get("/lawyer-ranking", async (req, res) => {
  const [lawyers] = await pool.execute(`
    SELECT l.id, l.name, l.firm,
           COUNT(c.id) as total_cases,
           SUM(CASE WHEN c.status = '已结案' THEN 1 ELSE 0 END) as closed_cases
    FROM lawyers l
    LEFT JOIN cases c ON l.id = c.lawyer_id
    WHERE c.status != '已驳回'
    GROUP BY l.id, l.name, l.firm
    ORDER BY total_cases DESC
  `);

  const result = [];
  for (const lawyer of lawyers) {
    const [cases] = await pool.execute(
      "SELECT * FROM cases WHERE lawyer_id = ? AND status != '已驳回'",
      [lawyer.id],
    );

    let overtimeCount = 0;
    for (const c of cases) {
      if (await checkCaseOvertime(c)) {
        overtimeCount++;
      }
    }

    result.push({
      lawyer_id: lawyer.id,
      lawyer_name: lawyer.name,
      firm: lawyer.firm,
      total_cases: lawyer.total_cases,
      closed_cases: lawyer.closed_cases,
      overtime_cases: overtimeCount,
      overtime_rate:
        lawyer.total_cases > 0
          ? Math.round((overtimeCount / lawyer.total_cases) * 10000) / 100
          : 0,
    });
  }

  result.sort((a, b) => b.overtime_rate - a.overtime_rate);
  result.forEach((item, index) => {
    item.rank = index + 1;
  });

  res.json(result);
});

router.get("/supervision-trend", async (req, res) => {
  const { months = 12 } = req.query;
  const monthCount = parseInt(months);

  const result = [];
  const now = new Date();

  for (let i = monthCount - 1; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const year = date.getFullYear();
    const month = date.getMonth() + 1;

    const [[row]] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM supervisions
       WHERE YEAR(created_at) = ? AND MONTH(created_at) = ?`,
      [year, month],
    );

    const [[escalatedRow]] = await pool.execute(
      `SELECT COUNT(*) as cnt FROM supervisions
       WHERE YEAR(created_at) = ? AND MONTH(created_at) = ? AND is_escalated = 1`,
      [year, month],
    );

    result.push({
      month: `${year}-${String(month).padStart(2, "0")}`,
      total: row.cnt,
      escalated: escalatedRow.cnt,
    });
  }

  res.json(result);
});

router.get("/supervision-efficiency", async (req, res) => {
  const [supervisions] = await pool.execute(
    "SELECT s.*, c.closed_at FROM supervisions s LEFT JOIN cases c ON s.case_id = c.id WHERE s.status = '已解除'",
  );

  let effectiveCount = 0;
  let totalResolved = 0;

  for (const s of supervisions) {
    if (s.resolved_at) {
      totalResolved++;
      const resolveDate = new Date(s.resolved_at);
      const requireDate = new Date(s.require_date);
      if (resolveDate <= requireDate) {
        effectiveCount++;
      }
    }
  }

  const [[totalSupervisions]] = await pool.execute(
    "SELECT COUNT(*) as total FROM supervisions",
  );

  res.json({
    total_supervisions: totalSupervisions.total,
    resolved_count: totalResolved,
    effective_count: effectiveCount,
    effective_rate:
      totalResolved > 0
        ? Math.round((effectiveCount / totalResolved) * 10000) / 100
        : 0,
  });
});

router.get("/overview", async (req, res) => {
  const [[totalCases]] = await pool.execute(
    "SELECT COUNT(*) as total FROM cases WHERE status != '已驳回'",
  );

  const [[processingCases]] = await pool.execute(
    "SELECT COUNT(*) as cnt FROM cases WHERE status IN ('待审批', '已批准', '已指派', '办理中')",
  );

  const [[closedCases]] = await pool.execute(
    "SELECT COUNT(*) as cnt FROM cases WHERE status = '已结案'",
  );

  const [[totalSupervisions]] = await pool.execute(
    "SELECT COUNT(*) as total FROM supervisions",
  );

  const [[activeSupervisions]] = await pool.execute(
    "SELECT COUNT(*) as cnt FROM supervisions WHERE status = '已发出'",
  );

  const [[seriousOvertime]] = await pool.execute(
    "SELECT COUNT(*) as cnt FROM cases WHERE is_serious_overtime = 1",
  );

  res.json({
    total_cases: totalCases.total,
    processing_cases: processingCases.cnt,
    closed_cases: closedCases.cnt,
    total_supervisions: totalSupervisions.total,
    active_supervisions: activeSupervisions.cnt,
    serious_overtime_cases: seriousOvertime.cnt,
  });
});

module.exports = router;
