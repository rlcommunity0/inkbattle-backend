module.exports = (sequelize, DataTypes) => {
  const Language = sequelize.define('Language', {
    id: { 
      type: DataTypes.BIGINT.UNSIGNED, 
      primaryKey: true, 
      autoIncrement: true 
    },
    languageName: { 
      type: DataTypes.STRING(50), 
      allowNull: false,
      unique: true 
    },
    languageCode: { 
      type: DataTypes.STRING(10), 
      allowNull: false,
      unique: true 
    }
//  }, { 
//    tableName: 'languages',
//    indexes: [
//      { unique: true, fields: ['languageName'] },
//      { unique: true, fields: ['languageCode'] }
//    ]
  }, {
    tableName: 'languages'
    // Indexes are created from column unique: true; no extra indexes array
    // to avoid duplicate keys and hitting MySQL's 64-key-per-table limit.
  });

  return Language;
};

