module.exports = (sequelize, DataTypes) => {
  const Keyword = sequelize.define(
    "Keyword",
    {
      id: {
        type: DataTypes.BIGINT.UNSIGNED,
        primaryKey: true,
        autoIncrement: true,
      },

      themeId: {
        type: DataTypes.BIGINT.UNSIGNED,
        allowNull: true,
        references: {
          model: "themes",
          key: "id",
        },
        onDelete: "CASCADE",
      },

      // Missing in your model — REQUIRED
      keyName: {
        type: DataTypes.STRING(255),
        allowNull: false,
      },

      // Missing in your model — REQUIRED
      languageCode: {
        type: DataTypes.STRING(10),
        allowNull: false,
      },

      // Missing in your model — REQUIRED
      category: {
        type: DataTypes.STRING(100),
        allowNull: true,
      },
    },
    {
      tableName: "keywords",
      indexes: [
        // FIXED: column now exists
        { unique: true, fields: ["keyName", "languageCode", "themeId"] },

        { fields: ["category"] },
        { fields: ["themeId"] },
        { fields: ["languageCode"] },
      ],
    },
  );

  return Keyword;
};
