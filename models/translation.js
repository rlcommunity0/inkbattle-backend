module.exports = (sequelize, DataTypes) => {
  const Translation = sequelize.define('Translation', {
    id: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      primaryKey: true, 
      autoIncrement: true 
    },
    keywordId: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      allowNull: false,
      references: {
        model: 'keywords',
        key: 'id'
      },
      onDelete: 'CASCADE'
    },
    languageId: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      allowNull: false,
      references: {
        model: 'languages',
        key: 'id'
      },
      onDelete: 'CASCADE'
    },
    scriptType: { 
      type: DataTypes.ENUM('roman', 'native'), 
      allowNull: false 
    },
    translatedText: { 
      type: DataTypes.STRING(255), 
      allowNull: false 
    }
  }, { 
    tableName: 'translations',
    indexes: [
      { unique: true, fields: ['keywordId', 'languageId', 'scriptType'] },
      { fields: ['keywordId'] },
      { fields: ['languageId'] },
      { fields: ['scriptType'] }
    ]
  });

  return Translation;
};

