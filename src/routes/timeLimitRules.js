const { Router } = require("express");
const { pool } = require("../db");
const router = Router();

router.get("/", async (req, res) => {
  const [rows] = await pool.execute(
    "SELECT * FROM time_limit_rules ORDER BY stage, case_type",
  );
  res.json(rows);
});

router.get("/:stage", async (req, res) => {
  const { stage } = req.params;
  const [rows] = await pool.execute(
    "SELECT * FROM time_limit_rules WHERE stage = ?",
    [stage],
  );
  res.json(rows);
});

async function getTimeLimitRule(stage, caseType) {
  const [[specificRule]] = await pool.execute(
    "SELECT * FROM time_limit_rules WHERE stage = ? AND case_type = ?",
    [stage, caseType],
  );
  if (specificRule) return specificRule;

  const [[generalRule]] = await pool.execute(
    "SELECT * FROM time_limit_rules WHERE stage = ? AND case_type = '通用'",
    [stage],
  );
  return generalRule || null;
}

router.post("/", async (req, res) => {
  const { stage, case_type, days, unit, description } = req.body;
  if (!stage || !case_type || !days) {
    return res.status(400).json({ error: "阶段、案件类型、天数为必填" });
  }
  try {
    const [result] = await pool.execute(
      "INSERT INTO time_limit_rules (stage, case_type, days, unit, description) VALUES (?, ?, ?, ?, ?)",
      [stage, case_type, days, unit || "工作日", description || null],
    );
    res.status(201).json({ id: result.insertId, message: "规则创建成功" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "该阶段和案件类型的规则已存在" });
    }
    throw err;
  }
});

router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { days, unit, description } = req.body;

  const [[rule]] = await pool.execute(
    "SELECT id FROM time_limit_rules WHERE id = ?",
    [id],
  );
  if (!rule) return res.status(404).json({ error: "规则不存在" });

  const updates = [];
  const params = [];
  if (days !== undefined) {
    updates.push("days = ?");
    params.push(days);
  }
  if (unit !== undefined) {
    updates.push("unit = ?");
    params.push(unit);
  }
  if (description !== undefined) {
    updates.push("description = ?");
    params.push(description);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "没有需要更新的字段" });
  }

  params.push(id);
  await pool.execute(
    `UPDATE time_limit_rules SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );
  res.json({ message: "规则更新成功" });
});

router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const [result] = await pool.execute(
    "DELETE FROM time_limit_rules WHERE id = ?",
    [id],
  );
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "规则不存在" });
  }
  res.json({ message: "规则删除成功" });
});

module.exports = router;
module.exports.getTimeLimitRule = getTimeLimitRule;
