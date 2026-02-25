module.exports = (sequelize, DataTypes) => {
  const CoinTransaction = sequelize.define('CoinTransaction', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    userId: { type: DataTypes.BIGINT.UNSIGNED },
    amount: { type: DataTypes.INTEGER },
    reason: { type: DataTypes.STRING }
  }, { tableName: 'coin_transactions' });

  return CoinTransaction;
};
