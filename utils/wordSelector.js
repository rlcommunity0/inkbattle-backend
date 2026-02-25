const { Keyword, Translation, Language, Theme } = require("../models");
const { Op } = require("sequelize");

/**
 * Get words for a theme based on room's language and script settings
 * @param {number} themeId - Theme ID (optional if categories provided)
 * @param {string} roomLanguage - Room language (EN, TE, HI, German, French, etc.)
 * @param {string} roomScript - Room script ('english' or 'default')
 * @param {number} limit - Optional limit for random words
 * @param {Array<string>} usedWords - Array of already used words
 * @param {Array<string>} categories - Array of category titles (for multi-select)
 * @returns {Promise<Array<string>>} Array of word texts
 */

//async function getWordsForTheme(themeId, roomLanguage, roomScript, limit = 3, usedWords = []) {
async function getWordsForTheme(themeId, roomLanguage, roomScript, limit = 3, usedWords = [], categories = []) {
  try {
    console.log(
      `getWordsForTheme: themeId=${themeId}, language=${roomLanguage}, script=${roomScript}, limit=${limit}`,
    );

    console.log(`getWordsForTheme: categories=${JSON.stringify(categories)}`);

    let targetThemeIds = [];

    // Case A: Multi-Select (Array)
    if (categories && Array.isArray(categories) && categories.length > 0) {
      const themes = await Theme.findAll({
        where: {
          title: {
            [Op.in]: categories // Pass array directly to Op.in
          }
        },
        attributes: ['id']
      });
      targetThemeIds = themes.map(t => t.id);
    } 
    // Case B: Fallback to single themeId
    else if (themeId) {
      targetThemeIds = [themeId];
    }
    
    console.log(`getWordsForTheme: targetThemeIds=${JSON.stringify(targetThemeIds)}`);
    if (targetThemeIds.length === 0) {
      console.log("⚠️ No themes found. Returning empty array.");
      return []; 
    }

    // --- 1. NORMALIZATION ---
    // Expanded map for better language handling
    const langCodeMap = {
      EN: "en",
      TE: "te",
      HI: "hi",
      KN: "kn",
      MR: "mr",
      FR: "fr",
      DE: "de",
      ENGLISH: "en",
      HINDI: "hi",
      TELUGU: "te",
      KANNADA: "kn",
      MARATHI: "mr",
      FRENCH: "fr",
      GERMAN: "de",
    };
    
    // Normalization logic to handle case-insensitive language names/codes
    const uppercaseLang = roomLanguage?.toUpperCase();
    const normalizedLangCode =
      langCodeMap[uppercaseLang] || 
      roomLanguage?.toLowerCase() ||
      "en"; 

    // Normalize script input to 'roman' (for english-like script) or 'native' (for default)
    let targetScriptType = (roomScript || "default").toLowerCase();
    
    if (targetScriptType === "english" || targetScriptType === "roman") {
      targetScriptType = "roman";
    } else { 
      // All other inputs (like 'default', 'native', etc.) map to the native script
      targetScriptType = "native"; 
    }

    // --- 2. TARGET DETERMINATION (FIXED LOGIC) ---
    
    let targetLanguageCode = normalizedLangCode;

    // SCENARIO 1: If English is the requested language, use 'en' and 'roman' script.
    if (normalizedLangCode === "en") {
        targetLanguageCode = "en";
        targetScriptType = "roman"; // English always uses roman script
    } 
    // SCENARIO 2: If a non-English language is requested, but the script is explicitly 'roman' (english-like).
    else if (targetScriptType === "roman") {
        // The original logic was flawed here. If a user asks for 'HI' and 'roman', 
        // they want the HINDI word in ROMAN script (e.g., "Paani"), NOT the English word.
        // The only time we switch to English is if the translation doesn't exist (see Step 4).
        targetLanguageCode = normalizedLangCode;
        targetScriptType = "roman";
    }
    // SCENARIO 3: If a non-English language is requested and the script is 'native' (default).
    else if (targetScriptType === "native") {
        targetLanguageCode = normalizedLangCode;
        targetScriptType = "native"; 
    }

    console.log(
      `    🎯 Target: language=${targetLanguageCode}, script=${targetScriptType}`,
    );

    // --- 3. FETCH DATA (REMOVED UNNECESSARY DEEP INCLUDE) ---
    // You only need the keywords for the theme and then load the necessary language/translations. 
    // However, keeping the deep include from the original code for stability,
    // assuming your Sequelize setup requires it for the filtering logic in Step 4 to work correctly.

    // Removed the inline deep-include to simplify the query and rely on the association setup.
    // NOTE: If you are relying on the included translations for the extraction logic in Step 4, 
    // the previous deep include is correct, but can be resource intensive.
    // We will keep the original include structure and focus on fixing the logic.

   // const theme = await Theme.findByPk(themeId, {
    // Fetch themes (single or multiple)
    const themes = await Theme.findAll({
      where: {
        id: {
          [Op.in]: targetThemeIds
        }
      },
      include: [
        {
          model: Keyword,
          as: "keywords",
          include: [
            {
              model: Translation,
              as: "translations",
              include: [
                {
                  model: Language,
                  as: "language",
                },
              ],
            },
          ],
        },
      ],
    });
    // Collect all keywords from all themes
    const allKeywords = [];
    for (const theme of themes) {
      if (theme.keywords && theme.keywords.length > 0) {
        allKeywords.push(...theme.keywords);
      }
    }

    // ... (Keyword check and logging remains the same) ...
    //if (!theme || !theme.keywords || theme.keywords.length === 0) {
     // console.log(`    ⚠️ No keywords found for theme ${themeId}`);
    if (allKeywords.length === 0) {
      console.log(`No keywords found for themes ${JSON.stringify(targetThemeIds)}`);
      return [];
    }

    //console.log(`    Found ${theme.keywords.length} keywords in theme`);
    console.log(`Found ${allKeywords.length} keywords across ${themes.length} theme(s)`);

    // Get the Language object for the calculated target language
    let targetLanguage = await Language.findOne({
      where: { languageCode: targetLanguageCode },
    });

    // Get the English Language object for final fallback
    const englishLanguage = await Language.findOne({
      where: { languageCode: "en" },
    });

    if (!targetLanguage) {
      console.log(
        `    ⚠️ Target Language not found: ${targetLanguageCode}, using English fallback.`,
      );
      // Fallback is handled later, but we need a valid targetLanguage object
      targetLanguage = englishLanguage;
      targetLanguageCode = "en";
      targetScriptType = "roman";
    }
    if (!englishLanguage) {
      console.log(
        `    ❌ English language (en) not found in database! Cannot guarantee fallback.`,
      );
      return [];
    }

    console.log(
      `    Using target language: ${targetLanguage.languageName} (${targetLanguage.languageCode}) with script: ${targetScriptType}`,
    );

    // --- 4. EXTRACT AND FALLBACK LOGIC (Minor cleanup) ---

    const words = [];
    for (const keyword of /*theme.keywords*/ allKeywords) {
      let finalTranslation = null;

      // --- 4a. PRIORITY 1: Check the determined target language and script ---
      // This will now correctly look for the requested non-English language and the native script type.
      finalTranslation = keyword.translations?.find(
        (t) =>
          t.languageId === targetLanguage.id &&
          t.scriptType === targetScriptType,
      );

      if (finalTranslation) {
        words.push(finalTranslation.translatedText);
        // console.log(`    ✅ Found primary translation for "${keyword.keyName}": ${finalTranslation.translatedText}`);
        continue;
      }

      // --- 4b. PRIORITY 2: Fallback to the OTHER script in the same language ---
      // This allows finding the Roman script if native was requested but missing, or vice versa.
      if (targetLanguage.languageCode !== "en") {
        const fallbackScript =
          targetScriptType === "roman" ? "native" : "roman";

        finalTranslation = keyword.translations?.find(
          (t) =>
            t.languageId === targetLanguage.id &&
            t.scriptType === fallbackScript,
        );

        if (finalTranslation) {
          words.push(finalTranslation.translatedText);
          // console.log(`    ⚠️ Found fallback script (${fallbackScript}) for "${keyword.keyName}": ${finalTranslation.translatedText}`);
          continue;
        }
      }

      // --- 4c. PRIORITY 3: GUARANTEED FALLBACK TO ENGLISH ROMAN ---

      finalTranslation = keyword.translations?.find(
        (t) => t.languageId === englishLanguage.id && t.scriptType === "roman",
      );

      if (finalTranslation) {
        words.push(finalTranslation.translatedText);
        // console.log(`    ⚠️ Universal fallback to English Roman for "${keyword.keyName}": ${finalTranslation.translatedText}`);
      } else {
        console.log(
          `    ❌ CRITICAL: Could not find English Roman translation for "${keyword.keyName}". Skipping.`,
        );
      }
    }

    console.log(`Found ${words.length} words after filtering`);
    let availableWords = words;
    if (usedWords && usedWords.length > 0) {
      availableWords = words.filter(w => !usedWords.includes(w));
      console.log(`Filtered out ${words.length - availableWords.length} used words.`);
    }
    if (availableWords.length < limit) {
      console.log("Ran out of unique words! Recycling pool for this turn.");
      availableWords = words;
    }
    console.log(`Available words pool (${availableWords.length}):`, JSON.stringify(availableWords));
    // Shuffle and limit if needed
    const shuffled = availableWords.sort(() => 0.5 - Math.random());
    const result = limit ? shuffled.slice(0, limit) : shuffled;

    console.log(
      `    Returning ${result.length} words${limit ? ` (limited to ${limit})` : ""}`,
    );

    return result;
  } catch (error) {
    console.error("❌ Error in getWordsForTheme:", error);
    console.error("Stack trace:", error.stack);
    return [];
  }
}

async function getRandomWordForTheme(themeId, roomLanguage, roomScript) {
  try {
    const words = await getWordsForTheme(themeId, roomLanguage, roomScript, 3);
    return words.length > 0 ? words : null;
  } catch (error) {
    console.error("❌ Error in getRandomWordForTheme:", error);
    return null;
  }
}

module.exports = {
  getWordsForTheme,
  getRandomWordForTheme,
};
