/**
 * Country Code Utility
 * 
 * Provides validation and normalization for ISO-2 country codes.
 * Supports backward compatibility with old country name format.
 */

// ISO 3166-1 alpha-2 country codes (all valid country codes)
const VALID_COUNTRY_CODES = new Set([
	'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
	'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
	'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
	'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
	'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
	'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
	'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
	'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
	'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
	'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
	'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
	'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
	'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
	'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
	'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
	'VN', 'VU', 'WF', 'WS', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
]);

// Mapping from old country names to ISO-2 codes (for backward compatibility)
const COUNTRY_NAME_TO_CODE = {
	'India': 'IN',
	'USA': 'US',
	'United States': 'US',
	'United States of America': 'US',
	'UK': 'GB',
	'United Kingdom': 'GB',
	'Japan': 'JP',
	'Spain': 'ES',
	'Portugal': 'PT',
	'France': 'FR',
	'Germany': 'DE',
	'Russia': 'RU',
	'Russian Federation': 'RU',
	'Ukraine': 'UA',
	'Canada': 'CA',
	'Australia': 'AU',
	'Brazil': 'BR',
	'Mexico': 'MX',
	'Italy': 'IT',
	'South Korea': 'KR',
	'Korea': 'KR',
	'China': 'CN',
	'Netherlands': 'NL',
	'Belgium': 'BE',
	'Switzerland': 'CH',
	'Sweden': 'SE',
	'Norway': 'NO',
	'Denmark': 'DK',
	'Finland': 'FI',
	'Poland': 'PL',
	'Turkey': 'TR',
	'Argentina': 'AR',
	'Chile': 'CL',
	'Colombia': 'CO',
	'Peru': 'PE',
	'Venezuela': 'VE',
	'South Africa': 'ZA',
	'Egypt': 'EG',
	'Nigeria': 'NG',
	'Kenya': 'KE',
	'Ghana': 'GH',
	'Morocco': 'MA',
	'Algeria': 'DZ',
	'Tunisia': 'TN',
	'Saudi Arabia': 'SA',
	'United Arab Emirates': 'AE',
	'UAE': 'AE',
	'Israel': 'IL',
	'Thailand': 'TH',
	'Vietnam': 'VN',
	'Philippines': 'PH',
	'Indonesia': 'ID',
	'Malaysia': 'MY',
	'Singapore': 'SG',
	'New Zealand': 'NZ',
	'Ireland': 'IE',
	'Greece': 'GR',
	'Czech Republic': 'CZ',
	'Czechia': 'CZ',
	'Romania': 'RO',
	'Hungary': 'HU',
	'Austria': 'AT',
	'Bangladesh': 'BD',
	'Pakistan': 'PK',
	'Sri Lanka': 'LK',
	'Nepal': 'NP',
	'Myanmar': 'MM',
	'Cambodia': 'KH',
	'Laos': 'LA',
	'Mongolia': 'MN',
	'Kazakhstan': 'KZ',
	'Uzbekistan': 'UZ',
	'Kyrgyzstan': 'KG',
	'Tajikistan': 'TJ',
	'Turkmenistan': 'TM',
	'Afghanistan': 'AF',
	'Iran': 'IR',
	'Iraq': 'IQ',
	'Jordan': 'JO',
	'Lebanon': 'LB',
	'Syria': 'SY',
	'Yemen': 'YE',
	'Oman': 'OM',
	'Kuwait': 'KW',
	'Qatar': 'QA',
	'Bahrain': 'BH',
};

/**
 * Normalizes a country value to ISO-2 code
 * @param {string|null|undefined} country - Country value (can be ISO-2 code, country name, or null)
 * @returns {string|null} - Normalized ISO-2 code or null if invalid/empty
 */
function normalizeCountryCode(country) {
	if (!country || typeof country !== 'string') {
		return null;
	}

	const trimmed = country.trim();

	if (trimmed.length === 0) {
		return null;
	}

	// If it's already a valid ISO-2 code (2 uppercase letters), return it
	if (trimmed.length === 2 && VALID_COUNTRY_CODES.has(trimmed.toUpperCase())) {
		return trimmed.toUpperCase();
	}

	// Check if it's a country name that we can map
	const normalizedName = trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
	if (COUNTRY_NAME_TO_CODE[normalizedName]) {
		return COUNTRY_NAME_TO_CODE[normalizedName];
	}

	// Try case-insensitive lookup
	for (const [name, code] of Object.entries(COUNTRY_NAME_TO_CODE)) {
		if (name.toLowerCase() === trimmed.toLowerCase()) {
			return code;
		}
	}

	// If we can't normalize it, return null (invalid country)
	return null;
}

/**
 * Validates if a country code is a valid ISO-2 code
 * @param {string|null|undefined} countryCode - Country code to validate
 * @returns {boolean} - True if valid ISO-2 code, false otherwise
 */
function isValidCountryCode(countryCode) {
	if (!countryCode || typeof countryCode !== 'string') {
		return false;
	}

	const normalized = normalizeCountryCode(countryCode);
	return normalized !== null;
}

/**
 * Validates and normalizes country code, throws error if invalid
 * @param {string|null|undefined} countryCode - Country code to validate
 * @param {boolean} allowNull - Whether null is allowed (default: true)
 * @returns {string|null} - Normalized ISO-2 code
 * @throws {Error} - If country code is invalid and allowNull is false
 */
function validateCountryCode(countryCode, allowNull = true) {
	if (!countryCode) {
		if (allowNull) {
			return null;
		}
		throw new Error('Country code is required');
	}

	const normalized = normalizeCountryCode(countryCode);

	if (normalized === null) {
		throw new Error(`Invalid country code: ${countryCode}. Must be a valid ISO-2 country code (e.g., 'US', 'IN', 'GB').`);
	}

	return normalized;
}

module.exports = {
	normalizeCountryCode,
	isValidCountryCode,
	validateCountryCode,
	VALID_COUNTRY_CODES,
	COUNTRY_NAME_TO_CODE,
};

