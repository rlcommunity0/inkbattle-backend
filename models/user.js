module.exports = (sequelize, DataTypes) => {
  const User = sequelize.define('User', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    name: { type: DataTypes.STRING, allowNull: true },
    profilePicture: { type: DataTypes.STRING, allowNull: true },
    provider: { type: DataTypes.ENUM('google', 'facebook', 'guest'), allowNull: false, defaultValue: 'guest' },
    providerId: { type: DataTypes.STRING, allowNull: true, unique: false },
    guestToken: { type: DataTypes.STRING, allowNull: true },
    coins: { type: DataTypes.INTEGER, defaultValue: 0 },
    avatar: { type: DataTypes.STRING, allowNull: true },
    language: { type: DataTypes.STRING, allowNull: true },
    country: { type: DataTypes.STRING, allowNull: true },
    lastLoginDate: { type: DataTypes.DATE, allowNull: true }, // Track daily login bonus
    dailyLoginStreak: { type: DataTypes.INTEGER, defaultValue: 0 } // Track consecutive logins
  }, { 
    tableName: 'users',
    indexes: [
      { unique: true, fields: ['provider', 'providerId'] },
      { unique: true, fields: ['guestToken'] }
    ]
  });
  return User;
};
