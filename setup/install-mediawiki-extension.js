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

console.log(`   [+] Processing MediaWiki extension: ${extensionName}...`);

// 1. Download and Extract via Docker or local curl (cross-platform fallback)
const tarUrl = `https://extdist.wmflabs.org/dist/extensions/${extensionName}-${mwVersion}.tar.gz`;
const targetTar = path.join(EXTENSIONS_DIR, `${extensionName}.tar.gz`);

try {
    // Ensure extension directory exists
    fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

    // Target folder inside extensions
    const destFolder = path.join(EXTENSIONS_DIR, extensionName);
    
    if (!fs.existsSync(destFolder)) {
        console.log(`   [*] Downloading tarball from ExtDist...`);
        
        // Cross-platform download using native curl
        execSync(`curl -sL "${tarUrl}" -o "${targetTar}"`);

        console.log(`   [*] Extracting asset archive...`);
        // Cross-platform extraction using native tar (supported natively in modern Windows 10/11 and Linux)
        execSync(`tar -xzf "${targetTar}" -C "${EXTENSIONS_DIR}"`);
        
        // Cleanup tarball
        if (fs.existsSync(targetTar)) {
            fs.unlinkSync(targetTar);
        }
    } else {
        console.log(`   [+] Source folder for ${extensionName} already exists. Skipping download.`);
    }

    // 2. Inject Configuration Settings into LocalSettings.php
    if (fs.existsSync(LOCAL_SETTINGS)) {
        let content = fs.readFileSync(LOCAL_SETTINGS, 'utf8');

        // Check if the extension is already loaded
        if (!content.includes(`wfLoadExtension( '${extensionName}' );`)) {
            console.log(`   [*] Registering extension configuration hooks inside LocalSettings.php...`);
            
            let injectBlock = `\n# Automatically injected configuration for ${extensionName}\n`;
            injectBlock += `wfLoadExtension( '${extensionName}' );\n`;

            if (settingsListRaw) {
                // Settings come in as a comma-separated string from the main process
                const settings = settingsListRaw.split(',');
                settings.forEach(setting => {
                    if (setting.trim()) {
                        injectBlock += `${setting.trim()}\n`;
                    }
                });
            }
            injectBlock += `# End of ${extensionName} configuration\n`;

            // Append to the bottom of LocalSettings.php
            fs.appendFileSync(LOCAL_SETTINGS, injectBlock, 'utf8');
            console.log(`   [+] ${extensionName} successfully mapped and injected.`);
        } else {
            console.log(`   [+] ${extensionName} registration block already detected. Skipping injection.`);
        }
    } else {
        console.warn(`   [-] Warning: LocalSettings.php not found at ${LOCAL_SETTINGS}. Registration skipped.`);
    }

} catch (error) {
    console.error(`   [-] Failed to install MediaWiki extension ${extensionName}: ${error.message}`);
    process.exit(1);
}