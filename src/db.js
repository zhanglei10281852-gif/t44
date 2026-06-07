const mysql = require("mysql2/promise");

const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  port: parseInt(process.env.DB_PORT || "3306"),
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "legal123",
  database: process.env.DB_NAME || "legal_aid",
  charset: "utf8mb4",
  waitForConnections: true,
  connectionLimit: 10,
});

async function initDb() {
  const conn = await pool.getConnection();
  try {
    await conn.execute(`
      CREATE TABLE IF NOT EXISTS applicants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        id_card VARCHAR(18) NOT NULL UNIQUE,
        gender ENUM('男','女') NOT NULL,
        phone VARCHAR(20),
        address VARCHAR(200),
        category ENUM('低保户','残疾人','老年人','未成年人','农民工','军人军属','其他') NOT NULL,
        income_level ENUM('无收入','低收入','一般'),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS lawyers (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        license_no VARCHAR(30) NOT NULL UNIQUE,
        phone VARCHAR(20),
        firm VARCHAR(100) NOT NULL,
        speciality VARCHAR(50),
        status ENUM('可接案','案件中','休假') NOT NULL DEFAULT '可接案',
        case_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS cases (
        id INT AUTO_INCREMENT PRIMARY KEY,
        case_no VARCHAR(20) NOT NULL UNIQUE,
        applicant_id INT NOT NULL,
        lawyer_id INT,
        case_type ENUM('民事','刑事','行政','劳动争议','婚姻家庭','其他') NOT NULL,
        description TEXT,
        status ENUM('待审批','已批准','已指派','办理中','已结案','已驳回') NOT NULL DEFAULT '待审批',
        approve_reason VARCHAR(500),
        reject_reason VARCHAR(500),
        result TEXT,
        approved_at DATETIME NULL,
        assigned_at DATETIME NULL,
        started_at DATETIME NULL,
        closed_at DATETIME NULL,
        special_deadline INT NULL,
        is_serious_overtime TINYINT(1) DEFAULT 0,
        supervision_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (applicant_id) REFERENCES applicants(id),
        FOREIGN KEY (lawyer_id) REFERENCES lawyers(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS time_limit_rules (
        id INT AUTO_INCREMENT PRIMARY KEY,
        stage ENUM('审批','指派','办理') NOT NULL,
        case_type ENUM('民事','刑事','行政','劳动争议','婚姻家庭','其他','通用') NOT NULL DEFAULT '通用',
        days INT NOT NULL,
        unit ENUM('工作日','自然日') NOT NULL DEFAULT '工作日',
        description VARCHAR(200),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uk_stage_type (stage, case_type)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS holidays (
        id INT AUTO_INCREMENT PRIMARY KEY,
        holiday_date DATE NOT NULL UNIQUE,
        name VARCHAR(50) NOT NULL,
        type ENUM('法定假日','调休工作日') NOT NULL,
        year INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS case_progress (
        id INT AUTO_INCREMENT PRIMARY KEY,
        case_id INT NOT NULL,
        progress_date DATE NOT NULL,
        description VARCHAR(500) NOT NULL,
        created_by INT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (case_id) REFERENCES cases(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    await conn.execute(`
      CREATE TABLE IF NOT EXISTS supervisions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        case_id INT NOT NULL,
        supervisor VARCHAR(50) NOT NULL,
        reason VARCHAR(500) NOT NULL,
        require_date DATE NOT NULL,
        status ENUM('已发出','已回复','已解除') NOT NULL DEFAULT '已发出',
        reply_estimate_date DATE NULL,
        reply_progress TEXT NULL,
        reply_at DATETIME NULL,
        resolved_at DATETIME NULL,
        is_escalated TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (case_id) REFERENCES cases(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);

    const [[ruleCount]] = await conn.execute(
      "SELECT COUNT(*) as cnt FROM time_limit_rules",
    );
    if (ruleCount.cnt === 0) {
      await conn.execute(`
        INSERT INTO time_limit_rules (stage, case_type, days, unit, description) VALUES
        ('审批', '通用', 5, '工作日', '审批阶段时限'),
        ('指派', '通用', 3, '工作日', '指派阶段时限'),
        ('办理', '民事', 60, '自然日', '民事案件办理时限'),
        ('办理', '刑事', 90, '自然日', '刑事案件办理时限'),
        ('办理', '行政', 60, '自然日', '行政案件办理时限'),
        ('办理', '劳动争议', 60, '自然日', '劳动争议案件办理时限'),
        ('办理', '婚姻家庭', 60, '自然日', '婚姻家庭案件办理时限'),
        ('办理', '其他', 60, '自然日', '其他案件办理时限')
      `);
    }

    console.log("数据库表初始化完成");
  } finally {
    conn.release();
  }
}

module.exports = { pool, initDb };
