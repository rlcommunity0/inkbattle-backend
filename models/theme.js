module.exports = (sequelize, DataTypes) => {
  const Theme = sequelize.define('Theme', {
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    title: { type: DataTypes.STRING, allowNull: false }
  }, { tableName: 'themes' });

  // Define the association inside an associate function
  Theme.associate = (models) => {
    // A Theme has many Keywords
    Theme.hasMany(models.Keyword, {
      foreignKey: 'themeId', 
      as: 'keywords', // Crucial alias used in getWordsForTheme: theme.keywords
      onDelete: 'CASCADE',
    });
  };

  return Theme;
};