const { pool } = require("../db");

function isWeekend(date) {
  const day = date.getDay();
  return day === 0 || day === 6;
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

async function getHolidayMap(startDate, endDate) {
  const startStr = formatDate(startDate);
  const endStr = formatDate(endDate);
  const [rows] = await pool.execute(
    "SELECT holiday_date, type FROM holidays WHERE holiday_date BETWEEN ? AND ?",
    [startStr, endStr]
  );
  const holidayMap = new Map();
  for (const row of rows) {
    holidayMap.set(formatDate(new Date(row.holiday_date)), row.type);
  }
  return holidayMap;
}

async function isWorkday(date) {
  const dateStr = formatDate(date);
  const [[row]] = await pool.execute(
    "SELECT type FROM holidays WHERE holiday_date = ?",
    [dateStr]
  );
  if (row) {
    return row.type === "调休工作日";
  }
  return !isWeekend(date);
}

async function countWorkdays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);

  if (start > end) return 0;

  const holidayMap = await getHolidayMap(start, end);
  let count = 0;
  const current = new Date(start);

  while (current <= end) {
    const dateStr = formatDate(current);
    const holidayType = holidayMap.get(dateStr);
    if (holidayType) {
      if (holidayType === "调休工作日") {
        count++;
      }
    } else if (!isWeekend(current)) {
      count++;
    }
    current.setDate(current.getDate() + 1);
  }

  return count;
}

function countNaturalDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  if (start > end) return 0;
  const diffMs = end - start;
  return Math.floor(diffMs / (1000 * 60 * 60 * 24));
}

async function addWorkdays(date, days) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  let added = 0;

  while (added < days) {
    result.setDate(result.getDate() + 1);
    if (await isWorkday(result)) {
      added++;
    }
  }

  return result;
}

async function getDeadline(startDate, limitDays, unit) {
  if (unit === "自然日") {
    const deadline = new Date(startDate);
    deadline.setDate(deadline.getDate() + limitDays);
    return deadline;
  } else {
    return await addWorkdays(startDate, limitDays);
  }
}

module.exports = {
  isWorkday,
  countWorkdays,
  countNaturalDays,
  addWorkdays,
  getDeadline,
  formatDate,
};
