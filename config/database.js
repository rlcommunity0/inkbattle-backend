const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME || 'inkbattles',
  process.env.DB_USER || 'root',
  process.env.DB_PASS || 'password',
  {
    host: process.env.DB_HOST || '127.0.0.1',
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: false,
    pool: { 
      max: 5, 
      min: 0, 
      acquire: 60000, 
      idle: 10000,
      evict: 1000,
      handleDisconnects: true
    },
    dialectOptions: {
      connectTimeout: 60000,
      keepAliveInitialDelay: 0,
      enableKeepAlive: true,
    },
    retry: {
      match: [
        /ETIMEDOUT/,
        /EHOSTUNREACH/,
        /ECONNRESET/,
        /ECONNREFUSED/,
        /ETIMEDOUT/,
        /ESOCKETTIMEDOUT/,
        /EHOSTUNREACH/,
        /EPIPE/,
        /EAI_AGAIN/,
        /SequelizeConnectionError/,
        /SequelizeConnectionRefusedError/,
        /SequelizeHostNotFoundError/,
        /SequelizeHostNotReachableError/,
        /SequelizeInvalidConnectionError/,
        /SequelizeConnectionTimedOutError/
      ],
      max: 3
    }
  }
);

// Sync database schema - alter: true adds missing columns without dropping data
//sequelize.sync({ alter: true }).catch(err => {
//  console.error('Database sync error:', err);
//});
// Do NOT sync here with alter: true. It runs on every restart and can hit MySQL's
// 64-key limit (ER_TOO_MANY_KEYS) when altering tables that already have many indexes.
// Schema sync (without alter) runs in server.js initializeServices().

module.exports = sequelize;
