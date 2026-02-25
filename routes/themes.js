const express = require('express');
const router = express.Router();
const { Theme, Word, Keyword, Translation, Language } = require('../models');
const { getWordsForTheme, getRandomWordForTheme } = require('../utils/wordSelector');

// create theme
router.post('/', async (req, res) => {
  const { title } = req.body;
  if (!title) return res.status(400).json({ error: 'title_required' });
  const theme = await Theme.create({ title });
  res.json({ theme });
});

// add word
router.post('/:themeId/words', async (req, res) => {
  const { text } = req.body;
  const { themeId } = req.params;
  if (!text) return res.status(400).json({ error: 'text_required' });
  const word = await Word.create({ themeId, text });
  res.json({ word });
});

// list themes with words
// Supports query params: ?language=en&script=roman (or native, all)
router.get('/', async (req, res) => {
  try {
    const { language, script } = req.query;
    
    console.log(`📋 GET /themes request: language=${language}, script=${script}`);

    // Try new keyword/translation system first
    if (language || script) {
      console.log('   Using keyword/translation system with filters');
      
      const themes = await Theme.findAll({
        include: [{
          model: Keyword,
          as: 'keywords',
          include: [{
            model: Translation,
            as: 'translations',
            include: [{
              model: Language,
              as: 'language'
            }]
          }]
        }]
      });

      // Filter translations based on language and script
      const filteredThemes = themes.map(theme => {
        const filteredKeywords = theme.keywords?.map(keyword => {
          let matchingTranslation = null;
          
          if (language && script) {
            // Find specific language and script
            const langCodeMap = {
              'EN': 'en', 'TE': 'te', 'HI': 'hi',
              'English': 'en', 'Hindi': 'hi', 'Telugu': 'te'
            };
            const normalizedLang = langCodeMap[language] || language?.toLowerCase();
            let normalizedScript = script.toLowerCase();
            
            // Support both old ('roman', 'native') and new ('english', 'default') script formats
            if (normalizedScript === 'roman') {
              normalizedScript = 'english';
            } else if (normalizedScript === 'native') {
              normalizedScript = 'default';
            }
            
            let targetLang = normalizedLang;
            let targetScript = 'roman'; // Default to roman
            
            // Logic consistent with wordSelector.js:
            // 1. If language is English → always use English words
            // 2. If language is not English:
            //    - script = "english" or "roman" → English words
            //    - script = "default" → romanized translation in user's language (e.g., "chetu" for tree in Telugu)
            //    - script = "native" → native script translation in user's language
            
            if (normalizedLang === 'en') {
              // English language always uses English words
              targetLang = 'en';
              targetScript = 'roman';
            } else if (normalizedScript === 'english' || normalizedScript === 'roman') {
              // User wants English words even though language is not English
              targetLang = 'en';
              targetScript = 'roman';
              console.log(`   📝 Keyword "${keyword.keyName}": Script is "${normalizedScript}" → Using English (en) regardless of selected language`);
            } else if (normalizedScript === 'default') {
              // User wants romanized translation in their selected language
              targetLang = normalizedLang;
              targetScript = 'roman';
              console.log(`   📝 Keyword "${keyword.keyName}": Script is "default" → Using ${normalizedLang} romanized words (e.g., "chetu" for tree in Telugu)`);
            } else if (normalizedScript === 'native') {
              // User wants native script translation in their selected language
              targetLang = normalizedLang;
              targetScript = 'native';
            }
            
            matchingTranslation = keyword.translations?.find(t => 
              t.language?.languageCode === targetLang && 
              t.scriptType === targetScript
            );
            
            // Fallback logic
            if (!matchingTranslation && targetScript === 'roman' && targetLang !== 'en') {
              // If roman not found for non-English language, try native script as fallback
              matchingTranslation = keyword.translations?.find(t => 
                t.language?.languageCode === targetLang && 
                t.scriptType === 'native'
              );
              if (matchingTranslation) {
                console.log(`   ⚠️  Roman translation not found for "${keyword.keyName}", using native`);
              }
            } else if (!matchingTranslation && targetScript === 'native') {
              // If native not found, try roman script of the same language
              matchingTranslation = keyword.translations?.find(t => 
                t.language?.languageCode === targetLang && 
                t.scriptType === 'roman'
              );
              if (matchingTranslation) {
                console.log(`   ⚠️  Native translation not found for "${keyword.keyName}", using roman`);
              }
            }
            
            // Last resort: try English only if script is 'english' (explicitly requested)
            // For 'default' script, we should NOT fallback to English
            if (!matchingTranslation && targetLang !== 'en' && normalizedScript === 'english') {
              matchingTranslation = keyword.translations?.find(t => 
                t.language?.languageCode === 'en' && 
                t.scriptType === 'roman'
              );
              if (matchingTranslation) {
                console.log(`   ⚠️  Fallback to English for "${keyword.keyName}"`);
              }
            }
          } else if (script === 'all') {
            // Return all translations
            return {
              id: keyword.id,
              keyName: keyword.keyName,
              category: keyword.category,
              translations: keyword.translations
            };
          }
          
          if (matchingTranslation) {
            return {
              id: keyword.id,
              keyName: keyword.keyName,
              category: keyword.category,
              text: matchingTranslation.translatedText,
              language: matchingTranslation.language?.languageCode,
              script: matchingTranslation.scriptType
            };
          }
          
          return null;
        }).filter(Boolean) || [];

        return {
          id: theme.id,
          title: theme.title,
          words: filteredKeywords
        };
      });

      console.log(`   ✅ Returning ${filteredThemes.length} themes with filtered keywords`);
      return res.json({ themes: filteredThemes });
    }

    // Default: return themes with keywords (all translations)
    console.log('   Using keyword/translation system (no filters)');
    const themes = await Theme.findAll({
      include: [
        {
          model: Keyword,
          as: 'keywords',
          include: [{
            model: Translation,
            as: 'translations',
            include: [{
              model: Language,
              as: 'language'
            }]
          }]
        },
        // Also include old Word model for backward compatibility
        {
          model: Word,
          required: false
        }
      ]
    });

    // Transform to include both old and new format
    const transformedThemes = themes.map(theme => ({
      id: theme.id,
      title: theme.title,
      // New keyword system
      keywords: theme.keywords?.map(k => ({
        id: k.id,
        keyName: k.keyName,
        category: k.category,
        translations: k.translations?.map(t => ({
          id: t.id,
          text: t.translatedText,
          language: t.language?.languageCode,
          script: t.scriptType
        }))
      })),
      // Old word system for backward compatibility
      Words: theme.Words || []
    }));

    console.log(`   ✅ Returning ${transformedThemes.length} themes`);
    return res.json({ themes: transformedThemes });

  } catch (error) {
    console.error('❌ Error in GET /themes:', error);
    res.status(500).json({ error: 'server_error', message: error.message });
  }
});

// Get all categories (themes) - simple list
router.get('/categories', async (req, res) => {
  try {
    console.log('📋 GET /themes/categories request');
    
    const themes = await Theme.findAll({
      attributes: ['id', 'title'],
      order: [['title', 'ASC']]
    });

    const categories = themes.map(theme => ({
      id: theme.id,
      title: theme.title
    }));

    console.log(`   ✅ Returning ${categories.length} categories`);
    return res.json({ categories });
  } catch (error) {
    console.error('❌ Error in GET /themes/categories:', error);
    res.status(500).json({ error: 'server_error', message: error.message });
  }
});

// random word by theme
// Supports query params: ?language=en&script=roman (or native)
router.get('/:themeId/random', async (req, res) => {
  try {
    const { themeId } = req.params;
    const { language, script } = req.query;
    
    console.log(`🎲 GET /themes/${themeId}/random request: language=${language}, script=${script}`);

    // Use new keyword/translation system if language/script provided
    if (language || script) {
      console.log('   Using keyword/translation system');
      
      const wordText = await getRandomWordForTheme(themeId, language, script);
      
      if (!wordText) {
        console.log('   ⚠️  No word found, trying fallback to old Word model');
        
        // Fallback to old Word model
        const words = await Word.findAll({ where: { themeId } });
        if (!words || words.length === 0) {
          return res.status(404).json({ error: 'no_words' });
        }
        const w = words[Math.floor(Math.random() * words.length)];
        console.log(`   ✅ Using fallback word: ${w.text}`);
        return res.json({ word: { id: w.id, text: w.text, themeId: w.themeId } });
      }
      
      console.log(`   ✅ Random word: ${wordText}`);
      
      // Return word in format compatible with frontend
      return res.json({ 
        word: { 
          text: wordText,
          themeId: parseInt(themeId)
        } 
      });
    }

    // Default: use old Word model for backward compatibility
    console.log('   Using old Word model (no language/script filter)');
    const words = await Word.findAll({ where: { themeId } });
    if (!words || words.length === 0) {
      // Try new system as fallback
      const wordText = await getRandomWordForTheme(themeId, 'en', 'roman');
      if (wordText) {
        return res.json({ word: { text: wordText, themeId: parseInt(themeId) } });
      }
      return res.status(404).json({ error: 'no_words' });
    }
    
    const w = words[Math.floor(Math.random() * words.length)];
    console.log(`   ✅ Random word: ${w.text}`);
    return res.json({ word: w });

  } catch (error) {
    console.error('❌ Error in GET /themes/:themeId/random:', error);
    res.status(500).json({ error: 'server_error', message: error.message });
  }
});

module.exports = router;
