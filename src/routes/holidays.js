const { Router } = require("express");
const { pool } = require("../db");
const { countWorkdays, formatDate } = require("../utils/workday");
const router = Router();

router.get("/", async (req, res) => {
  const { year, type, page = 1, size = 50 } = req.query;
  let conditions = [];
  let params = [];

  if (year) {
    conditions.push("year = ?");
    params.push(year);
  }
  if (type) {
    conditions.push("type = ?");
    params.push(type);
  }

  const where = conditions.length ? " WHERE " + conditions.join(" AND ") : "";

  const [[{ total }]] = await pool.execute(
    `SELECT COUNT(*) as total FROM holidays${where}`,
    params,
  );

  const limit = parseInt(size);
  const offset = (parseInt(page) - 1) * limit;

  const [data] = await pool.execute(
    `SELECT * FROM holidays${where} ORDER BY holiday_date LIMIT ${limit} OFFSET ${offset}`,
    params,
  );

  res.json({ total, page: parseInt(page), size: limit, data });
});

router.post("/", async (req, res) => {
  const { holiday_date, name, type } = req.body;
  if (!holiday_date || !name || !type) {
    return res.status(400).json({ error: "日期、名称、类型为必填" });
  }

  const date = new Date(holiday_date);
  const year = date.getFullYear();

  try {
    const [result] = await pool.execute(
      "INSERT INTO holidays (holiday_date, name, type, year) VALUES (?, ?, ?, ?)",
      [holiday_date, name, type, year],
    );
    res.status(201).json({ id: result.insertId, message: "假日添加成功" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "该日期已存在" });
    }
    throw err;
  }
});

router.post("/batch", async (req, res) => {
  const { holidays } = req.body;
  if (!Array.isArray(holidays) || holidays.length === 0) {
    return res.status(400).json({ error: "假日列表不能为空" });
  }

  const values = [];
  const params = [];

  for (const h of holidays) {
    if (!h.holiday_date || !h.name || !h.type) {
      return res
        .status(400)
        .json({ error: "每条假日数据必须包含日期、名称、类型" });
    }
    const date = new Date(h.holiday_date);
    const year = date.getFullYear();
    values.push("(?, ?, ?, ?)");
    params.push(h.holiday_date, h.name, h.type, year);
  }

  try {
    const [result] = await pool.execute(
      `INSERT INTO holidays (holiday_date, name, type, year) VALUES ${values.join(", ")}`,
      params,
    );
    res
      .status(201)
      .json({ count: result.affectedRows, message: "批量添加成功" });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") {
      return res.status(400).json({ error: "存在重复的日期" });
    }
    throw err;
  }
});

router.put("/:id", async (req, res) => {
  const { id } = req.params;
  const { holiday_date, name, type } = req.body;

  const [[holiday]] = await pool.execute(
    "SELECT id FROM holidays WHERE id = ?",
    [id],
  );
  if (!holiday) return res.status(404).json({ error: "假日不存在" });

  const updates = [];
  const params = [];

  if (holiday_date !== undefined) {
    updates.push("holiday_date = ?");
    params.push(holiday_date);
    const date = new Date(holiday_date);
    updates.push("year = ?");
    params.push(date.getFullYear());
  }
  if (name !== undefined) {
    updates.push("name = ?");
    params.push(name);
  }
  if (type !== undefined) {
    updates.push("type = ?");
    params.push(type);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: "没有需要更新的字段" });
  }

  params.push(id);
  await pool.execute(
    `UPDATE holidays SET ${updates.join(", ")} WHERE id = ?`,
    params,
  );
  res.json({ message: "假日更新成功" });
});

router.delete("/:id", async (req, res) => {
  const { id } = req.params;
  const [result] = await pool.execute("DELETE FROM holidays WHERE id = ?", [
    id,
  ]);
  if (result.affectedRows === 0) {
    return res.status(404).json({ error: "假日不存在" });
  }
  res.json({ message: "假日删除成功" });
});

router.get("/workdays/count", async (req, res) => {
  const { start_date, end_date } = req.query;
  if (!start_date || !end_date) {
    return res.status(400).json({ error: "开始日期和结束日期为必填" });
  }
  const days = await countWorkdays(start_date, end_date);
  res.json({ start_date, end_date, workdays: days });
});

module.exports = router;
