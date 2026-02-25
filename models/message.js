module.exports = (sequelize, DataTypes) => {
  const Message = sequelize.define('Message', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    roomId: { type: DataTypes.BIGINT.UNSIGNED },
    userId: { type: DataTypes.BIGINT.UNSIGNED },
    content: { type: DataTypes.TEXT, allowNull: false },
    type: { type: DataTypes.STRING, defaultValue: 'text' } // 'text' or 'system'
  }, { tableName: 'messages' });

  return Message;
};
