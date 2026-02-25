const { Theme, Language, Keyword, Translation } = require('../models');
const { Op } = require('sequelize');

// Translation data for keywords
// Format: { keyName: { en: {roman, native}, hi: {roman, native}, te: {roman, native} }, category }
const keywordsData = {
  // Fruits
  'Apple': {
    en: { roman: 'Apple', native: 'Apple' },
    hi: { roman: 'Seb', native: 'सेब' },
    te: { roman: 'Kaya', native: 'కాయ' },
    category: 'Fruits'
  },
  'Banana': {
    en: { roman: 'Banana', native: 'Banana' },
    hi: { roman: 'Kela', native: 'केला' },
    te: { roman: 'Aratipandu', native: 'అరటిపండు' },
    category: 'Fruits'
  },
  'Orange': {
    en: { roman: 'Orange', native: 'Orange' },
    hi: { roman: 'Santra', native: 'संतरा' },
    te: { roman: 'Kamala', native: 'కమల' },
    category: 'Fruits'
  },
  'Mango': {
    en: { roman: 'Mango', native: 'Mango' },
    hi: { roman: 'Aam', native: 'आम' },
    te: { roman: 'Mamidi', native: 'మామిడి' },
    category: 'Fruits'
  },
  'Grapes': {
    en: { roman: 'Grapes', native: 'Grapes' },
    hi: { roman: 'Angur', native: 'अंगूर' },
    te: { roman: 'Draksha', native: 'ద్రాక్ష' },
    category: 'Fruits'
  },
  'Watermelon': {
    en: { roman: 'Watermelon', native: 'Watermelon' },
    hi: { roman: 'Tarbuj', native: 'तरबूज' },
    te: { roman: 'Puccha', native: 'పుచ్చ' },
    category: 'Fruits'
  },
  'Pineapple': {
    en: { roman: 'Pineapple', native: 'Pineapple' },
    hi: { roman: 'Ananas', native: 'अनानास' },
    te: { roman: 'Anasa', native: 'అనాస' },
    category: 'Fruits'
  },
  'Strawberry': {
    en: { roman: 'Strawberry', native: 'Strawberry' },
    hi: { roman: 'Strawberry', native: 'स्ट्रॉबेरी' },
    te: { roman: 'Strawberry', native: 'స్ట్రాబెర్రీ' },
    category: 'Fruits'
  },
  // Animals
  'Dog': {
    en: { roman: 'Dog', native: 'Dog' },
    hi: { roman: 'Kutta', native: 'कुत्ता' },
    te: { roman: 'Kukka', native: 'కుక్క' },
    category: 'Animals'
  },
  'Cat': {
    en: { roman: 'Cat', native: 'Cat' },
    hi: { roman: 'Billi', native: 'बिल्ली' },
    te: { roman: 'Pilli', native: 'పిల్లి' },
    category: 'Animals'
  },
  'Elephant': {
    en: { roman: 'Elephant', native: 'Elephant' },
    hi: { roman: 'Hathi', native: 'हाथी' },
    te: { roman: 'Enugu', native: 'ఏనుగు' },
    category: 'Animals'
  },
  'Lion': {
    en: { roman: 'Lion', native: 'Lion' },
    hi: { roman: 'Sher', native: 'शेर' },
    te: { roman: 'Simham', native: 'సింహం' },
    category: 'Animals'
  },
  'Tiger': {
    en: { roman: 'Tiger', native: 'Tiger' },
    hi: { roman: 'Bagh', native: 'बाघ' },
    te: { roman: 'Puli', native: 'పులి' },
    category: 'Animals'
  },
  // Food
  'Pizza': {
    en: { roman: 'Pizza', native: 'Pizza' },
    hi: { roman: 'Pizza', native: 'पिज्जा' },
    te: { roman: 'Pizza', native: 'పిజ్జా' },
    category: 'Food'
  },
  'Burger': {
    en: { roman: 'Burger', native: 'Burger' },
    hi: { roman: 'Burger', native: 'बर्गर' },
    te: { roman: 'Burger', native: 'బర్గర్' },
    category: 'Food'
  },
  'Rice': {
    en: { roman: 'Rice', native: 'Rice' },
    hi: { roman: 'Chawal', native: 'चावल' },
    te: { roman: 'Biyyam', native: 'బియ్యం' },
    category: 'Food'
  },
  // Movies (using English for all since they're proper nouns)
  'Titanic': {
    en: { roman: 'Titanic', native: 'Titanic' },
    hi: { roman: 'Titanic', native: 'टाइटैनिक' },
    te: { roman: 'Titanic', native: 'టైటానిక్' },
    category: 'Movies'
  },
  'Avatar': {
    en: { roman: 'Avatar', native: 'Avatar' },
    hi: { roman: 'Avatar', native: 'अवतार' },
    te: { roman: 'Avatar', native: 'అవతార్' },
    category: 'Movies'
  }
};

// 4 Themes with their keywords
const themesData = [
  {
    title: 'Fruits',
    keywords: ['Apple', 'Banana', 'Orange', 'Mango', 'Grapes', 'Watermelon', 'Pineapple', 'Strawberry']
  },
  {
    title: 'Animals',
    keywords: ['Dog', 'Cat', 'Elephant', 'Lion', 'Tiger']
  },
  {
    title: 'Food',
    keywords: ['Pizza', 'Burger', 'Rice']
  },
  {
    title: 'Movies',
    keywords: ['Titanic', 'Avatar']
  }
];

async function seedThemes() {
  try {
    console.log('🌱 Starting multilingual theme and keyword seeding...');
    console.log('═══════════════════════════════════════════════════════════');

    // Step 1: Seed Languages
    console.log('\n📚 Step 1: Seeding languages...');
    const languagesMap = {};
    
    const languageData = [
      { languageName: 'english', languageCode: 'en' },
      { languageName: 'hindi', languageCode: 'hi' },
      { languageName: 'telugu', languageCode: 'te' }
    ];

    for (const langData of languageData) {
      let language = await Language.findOne({ 
        where: { languageCode: langData.languageCode } 
      });
      
      if (!language) {
        language = await Language.create(langData);
        console.log(`   ✅ Created language: ${langData.languageName} (${langData.languageCode})`);
      } else {
        console.log(`   ⏭️  Language already exists: ${langData.languageName} (${langData.languageCode})`);
      }
      
      languagesMap[langData.languageCode] = language;
    }

    // Step 2: Seed Keywords and Translations
    console.log('\n🔑 Step 2: Seeding keywords and translations...');
    const keywordsMap = {};
    let keywordsCreated = 0;
    let translationsCreated = 0;

    for (const [keyName, translationData] of Object.entries(keywordsData)) {
      // Create or get keyword
      let keyword = await Keyword.findOne({ where: { keyName } });
      
      if (!keyword) {
        keyword = await Keyword.create({
          keyName,
          category: translationData.category
        });
        keywordsCreated++;
        console.log(`   ✅ Created keyword: ${keyName} (category: ${translationData.category})`);
      } else {
        console.log(`   ⏭️  Keyword already exists: ${keyName}`);
      }
      
      keywordsMap[keyName] = keyword;

      // Create translations for each language
      for (const [langCode, langData] of Object.entries(translationData)) {
        if (langCode === 'category') continue; // Skip category field
        
        const language = languagesMap[langCode];
        if (!language) {
          console.log(`   ⚠️  Language not found: ${langCode}, skipping translations`);
          continue;
        }

        // Create roman translation
        const romanTranslation = await Translation.findOne({
          where: {
            keywordId: keyword.id,
            languageId: language.id,
            scriptType: 'roman'
          }
        });

        if (!romanTranslation) {
          await Translation.create({
            keywordId: keyword.id,
            languageId: language.id,
            scriptType: 'roman',
            translatedText: langData.roman
          });
          translationsCreated++;
          console.log(`      📝 Added roman translation (${langCode}): ${langData.roman}`);
        }

        // Create native translation
        const nativeTranslation = await Translation.findOne({
          where: {
            keywordId: keyword.id,
            languageId: language.id,
            scriptType: 'native'
          }
        });

        if (!nativeTranslation) {
          await Translation.create({
            keywordId: keyword.id,
            languageId: language.id,
            scriptType: 'native',
            translatedText: langData.native
          });
          translationsCreated++;
          console.log(`      📝 Added native translation (${langCode}): ${langData.native}`);
        }
      }
    }

    console.log(`\n   📊 Keywords: ${keywordsCreated} created, ${Object.keys(keywordsMap).length} total`);
    console.log(`   📊 Translations: ${translationsCreated} created`);

    // Step 3: Seed Themes and associate with Keywords
    console.log('\n🎨 Step 3: Seeding themes and associating keywords...');
    let themesCreated = 0;
    let associationsCreated = 0;

    for (const themeData of themesData) {
      // Create or get theme
      let theme = await Theme.findOne({ where: { title: themeData.title } });
      
      if (!theme) {
        theme = await Theme.create({ title: themeData.title });
        themesCreated++;
        console.log(`   ✅ Created theme: ${themeData.title}`);
      } else {
        console.log(`   ⏭️  Theme already exists: ${themeData.title}`);
      }

      // Associate keywords with theme
      let themeAssociations = 0;
      for (const keyName of themeData.keywords) {
        const keyword = keywordsMap[keyName];
        if (!keyword) {
          console.log(`   ⚠️  Keyword not found: ${keyName}, skipping association`);
          continue;
        }

        // Check if association exists by querying theme's keywords
        const themeWithKeyword = await Theme.findByPk(theme.id, {
          include: [{
            model: Keyword,
            as: 'keywords',
            where: { id: keyword.id },
            required: false
          }]
        });

        const existingAssociation = themeWithKeyword?.keywords?.length > 0;

        if (!existingAssociation) {
          await theme.addKeyword(keyword);
          themeAssociations++;
          associationsCreated++;
        }
      }
      
      console.log(`      🔗 Associated ${themeAssociations} keywords with ${themeData.title}`);
    }

    console.log(`\n   📊 Themes: ${themesCreated} created, ${themesData.length} total`);
    console.log(`   📊 Theme-Keyword associations: ${associationsCreated} created`);

    // Step 4: Summary
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('✅ Multilingual theme and keyword seeding completed!');
    
    const totalThemes = await Theme.count();
    const totalKeywords = await Keyword.count();
    const totalTranslations = await Translation.count();
    const totalLanguages = await Language.count();
    
    console.log('\n📊 Final Summary:');
    console.log(`   Total Languages: ${totalLanguages}`);
    console.log(`   Total Themes: ${totalThemes}`);
    console.log(`   Total Keywords: ${totalKeywords}`);
    console.log(`   Total Translations: ${totalTranslations}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    
  } catch (error) {
    console.error('\n❌ Error seeding themes:', error);
    console.error('Stack trace:', error.stack);
    throw error;
  }
}

module.exports = { seedThemes };

// Run if called directly
if (require.main === module) {
  const { sequelize } = require('../models');
  
  sequelize.sync({ alter: true }).then(async () => {
    await seedThemes();
    process.exit(0);
  }).catch(err => {
    console.error('Database sync error:', err);
    process.exit(1);
  });
}
