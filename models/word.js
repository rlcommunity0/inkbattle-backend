module.exports = (sequelize, DataTypes) => {
  const Word = sequelize.define('Word', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    themeId: { type: DataTypes.BIGINT.UNSIGNED },
    text: { type: DataTypes.STRING, allowNull: false }
  }, { tableName: 'words' });

  return Word;
};
