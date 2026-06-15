// =====================================================================
// MediaWiki Extension Installer Sub-Module (Node.js Component)
// =====================================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Parse command line arguments manually to avoid dependencies
const args = process.argv.slice(2);
const params = {};
for (let i = 0; i < args.length; i += 2) {
    const key = args[i].replace(/^-+/, '');
    const value = args[i + 1];
    params[key] = value;
}

// תמיכה ב-Case-insensitive עבור הארגומנטים
const extensionName = params.ExtensionName || params.extensionname;
const mwVersion = params.MwVersion || params.mwversion;
const settingsListRaw = params.SettingsList || params.settingslist;

if (!extensionName || !mwVersion) {
    console.error("[-] Missing required arguments: --ExtensionName and --MwVersion");
    process.exit(1);
}

const ROOT_DIR = path.resolve(__dirname, '..');
const MEDIAWIKI_DIR = path.join(ROOT_DIR, 'content_engines', 'mediawiki');
const EXTENSIONS_DIR = path.join(MEDIAWIKI_DIR, 'extensions');
const LOCAL_SETTINGS = path.join(MEDIAWIKI_DIR, 'LocalSettings.php');
const CONTAINER_TARGET = `/var/www/html/extensions`;

console.log(`\n   [+] Processing MediaWiki extension: ${extensionName}...`);

try {
// 1. גירוד דינמי של דף ההפצות כדי למצוא את הקישור האמיתי כולל חתימת ה-Commit
    console.log(`      [→] Scanning MediaWiki ExtDist repository for exact filename...`);
    const repoUrl = `https://extdist.wmflabs.org/dist/extensions/`;
    
    // תיקון: הגדרת maxBuffer ל-50MB כדי למנוע שגיאות ENOBUFS בווינדוס
    const htmlList = execSync(`docker exec c_mediawiki curl -k -s "${repoUrl}"`, { 
        encoding: 'utf8',
        maxBuffer: 50 * 1024 * 1024 
    });  
    // חיפוש שם הקובץ המלא שמתחיל בשם התוסף ומכיל את הגרסה וחתימת ה-Commit הדינמית
    const regex = new RegExp(`href="(${extensionName}-${mwVersion}-[a-f0-9]+\\.tar\\.gz)"`);
    const match = htmlList.match(regex);
    
    let finalTarballName = '';
    if (match && match[1]) {
        finalTarballName = match[1];
        console.log(`      [✓] Dynamically discovered remote asset: ${finalTarballName}`);
    } else {
        // Fallback למקרה הקיצון שהם לא משתמשים בחתימה
        finalTarballName = `${extensionName}-${mwVersion}.tar.gz`;
        console.log(`      [-] Warning: Commit hash not found, trying fallback filename...`);
    }

    const downloadUrl = `${repoUrl}${finalTarballName}`;

    // 2. הורדת הקובץ האמיתי והמלא ישירות לתוך הקונטיינר (בלי לעבור דרך ווינדוס)
    console.log(`      [→] Downloading dynamic archive inside container...`);
    execSync(`docker exec -w ${CONTAINER_TARGET} c_mediawiki curl -k -L -o ${extensionName}.tar.gz "${downloadUrl}"`);

    // 3. חילוץ הארכיון בתוך סביבת הלינוקס של הקונטיינר (מונע שגיאות tar של ווינדוס)
    console.log(`      [→] Extracting extension inside container...`);
    execSync(`docker exec -w ${CONTAINER_TARGET} c_mediawiki tar -xzf ${extensionName}.tar.gz`, { stdio: 'ignore' });

    // 4. ניקוי קובץ ה-tar.gz הזמני מהקונטיינר
    console.log(`      [→] Cleaning up temporary container archive...`);
    execSync(`docker exec -w ${CONTAINER_TARGET} c_mediawiki rm ${extensionName}.tar.gz`, { stdio: 'ignore' });

    // 5. הזרקת הגדרות ה-LocalSettings.php המקומי של הפרויקט
    if (fs.existsSync(LOCAL_SETTINGS)) {
        let content = fs.readFileSync(LOCAL_SETTINGS, 'utf8');

        // בדיקה אם ההרחבה כבר רשומה בקובץ
        if (!content.includes(`wfLoadExtension( '${extensionName}' );`)) {
            console.log(`      [→] Registering extension configuration hooks inside LocalSettings.php...`);
            
            let injectBlock = `\n# Automatically injected configuration for ${extensionName}\n`;
            injectBlock += `wfLoadExtension( '${extensionName}' );\n`;

            if (settingsListRaw) {
                // המרה של פסיקים חזרה לשורות קוד נקיות
                const settings = settingsListRaw.split(',');
                settings.forEach(setting => {
                    if (setting.trim()) {
                        injectBlock += `${setting.trim()}\n`;
                    }
                });
            }
            injectBlock += `# End of ${extensionName} configuration\n`;

            // אפנד לסוף הקובץ
            fs.appendFileSync(LOCAL_SETTINGS, injectBlock, 'utf8');
            console.log(`      [✓] ${extensionName} successfully mapped and injected.`);
        } else {
            console.log(`      [+] ${extensionName} registration block already detected. Skipping injection.`);
        }
    } else {
        console.warn(`      [-] Warning: LocalSettings.php not found at ${LOCAL_SETTINGS}. Registration skipped.`);
    }

} catch (error) {
    console.error(`   [-] Failed to install MediaWiki extension ${extensionName}: ${error.message}`);
    process.exit(1);
}