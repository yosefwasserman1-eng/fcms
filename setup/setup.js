// =====================================================================
// Corinthian Archive - Automated Immutable Setup Pipeline (Node.js)
// =====================================================================
const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

console.log("====================================================");
console.log("[*] Starting Automated Deployment (Corinthian Stack)");
console.log("====================================================");

// Resolve base paths relative to the script location
const ROOT_DIR = path.resolve(__dirname, '..');
const GATEWAY_NGINX = path.join(ROOT_DIR, 'gateway', 'nginx');

// Helper function to safely execute shell commands with inherited I/O
function runCmd(command, options = {}) {
    try {
        execSync(command, { cwd: ROOT_DIR, stdio: 'inherit', ...options });
    } catch (error) {
        console.error(`[-] Command failed: ${command}`);
        process.exit(1);
    }
}

// Helper function to expand environment variables ${VAR} inside text
function expandEnvVars(text) {
    return text.replace(/\$\{([^}]+)\}/g, (_, envVar) => process.env[envVar] || '');
}

// ---------------------------------------------------------
// Phase 0: Load Environment Variables & Environment Cleanup
// ---------------------------------------------------------
console.log("\n[0/6] Loading network variables and secrets from .env...");
const envPath = path.join(ROOT_DIR, '.env');

if (fs.existsSync(envPath)) {
    const envConfig = fs.readFileSync(envPath, 'utf8');
    envConfig.split('\n').forEach(line => {
        const match = line.trim().match(/^(?!#)([^=]+)=(.*)$/);
        if (match) {
            const key = match[1].trim();
            let value = match[2].trim();
            // Remove wrapping quotes if present
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
                value = value.slice(1, -1);
            }
            process.env[key] = value;
        }
    });
} else {
    console.error("[-] Error: .env file is missing from root directory! Cannot proceed.");
    process.exit(1);
}

console.log("[*] Cleaning up legacy containers and orphaned volumes...");
runCmd("docker compose down -v", { stdio: 'ignore' });

// ---------------------------------------------------------
// Phase 1: Local SSL/TLS Certificate Verification
// ---------------------------------------------------------
console.log("\n[1/6] Verifying local SSL/TLS certificates in gateway/cart layer...");
const GATEWAY_CART = path.join(ROOT_DIR, 'gateway', 'cart');
const certFile = path.join(GATEWAY_CART, 'cert.pem');
const keyFile = path.join(GATEWAY_CART, 'key.pem');

if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
    console.log("[*] Certificates missing. Generating new local SSL certs via mkcert inside gateway/cart...");
    try {
        // ודואג שתיקיית cart קיימת (אם היא לא נוצרה עדיין)
        fs.mkdirSync(GATEWAY_CART, { recursive: true });
        
        const domains = [
            process.env.DOMAIN_ARCHIVE,
            process.env.DOMAIN_FORUM,
            process.env.DOMAIN_WIKI,
            process.env.DOMAIN_SSO,
            process.env.DOMAIN_CORE
        ].filter(Boolean).join(' ');

        execSync("mkcert -install", { stdio: 'ignore' });
        execSync(`mkcert -cert-file "${certFile}" -key-file "${keyFile}" ${domains}`, { stdio: 'ignore' });

        if (fs.existsSync(certFile)) {
            console.log("[+] Certificates generated inside gateway/cart successfully!");
        } else {
            throw new Error("Files were not created by mkcert.");
        }
    } catch (error) {
        console.error("[-] Error: mkcert generation failed. Verify mkcert is installed and added to PATH.");
        process.exit(1);
    }
} else {
    console.log("[+] Active SSL certificates found in gateway/cart. Skipping generation.");
}

// --- הוספה חדשה: יצירת קונפיג NodeBB דינמי ---
const nodebbTemplatePath = path.join(ROOT_DIR, 'content_engines', 'nodebb', 'config', 'config.json.template');
const nodebbConfigPath = path.join(ROOT_DIR, 'content_engines', 'nodebb', 'config', 'config.json');

if (fs.existsSync(nodebbTemplatePath)) {
    console.log("[*] Generating dynamic NodeBB config.json from template...");
    const nodebbTemplateText = fs.readFileSync(nodebbTemplatePath, 'utf8');
    const compiledNodebbConf = expandEnvVars(nodebbTemplateText);
    fs.writeFileSync(nodebbConfigPath, compiledNodebbConf, 'utf8');
    console.log("[+] Dynamic NodeBB config.json generated successfully!");
} else {
    console.error("[-] Warning: config.json.template missing from content_engines/nodebb/config/!");
}
// ---------------------------------------------------------
// Phase 2: Docker Cacheless Build & Orchestration
// ---------------------------------------------------------
console.log("\n[2/6] Building clean containers and initializing databases...");
runCmd("docker compose build --no-cache");

console.log("[*] Launching database clusters...");
runCmd("docker compose up -d db nodebb-db");

console.log("[*] Waiting 15 seconds for database initialization and init.sql injection...");
runCmd(process.platform === 'win32' ? "timeout /t 15" : "sleep 15", { stdio: 'ignore' });

console.log("[*] Launching the remaining stack application layers...");
runCmd("docker compose up -d");

console.log("[*] Waiting 20 seconds for core platforms (PHP/Node) to boot up...");
runCmd(process.platform === 'win32' ? "timeout /t 20" : "sleep 20", { stdio: 'ignore' });

// ---------------------------------------------------------
// Phase 3: WordPress Automated Configuration & Dependency Injection
// ---------------------------------------------------------
console.log("\n[3/6] Configuring WordPress plugins and options...");
try {
    const wpJsonPath = path.join(__dirname, 'wordpress-plugins.json');
    if (fs.existsSync(wpJsonPath)) {
        const rawJson = fs.readFileSync(wpJsonPath, 'utf8');
        const expandedJson = expandEnvVars(rawJson);
        const wpPlugins = JSON.parse(expandedJson);

        wpPlugins.forEach(plugin => {
            console.log(`   ⚙️ Installing and activating: ${plugin.slug}`);
            runCmd(`docker compose exec -T -u www-data wordpress wp plugin install ${plugin.slug} --activate`, { stdio: 'ignore' });

            if (plugin.options) {
                Object.entries(plugin.options).forEach(([key, value]) => {
                    runCmd(`docker compose exec -T -u www-data wordpress wp option update ${key} "${value}"`, { stdio: 'ignore' });
                });
            }
        });
        console.log("[+] WordPress environment setup completed!");
    }
} catch (error) {
    console.log("[-] Warning: WordPress plugin automation step failed gracefully.");
}

// ---------------------------------------------------------
// Phase 4: MediaWiki Dynamic Installation (Hybrid CLI Fallback)
// ---------------------------------------------------------
console.log("\n[4/6] Initializing MediaWiki extension compiler...");
try {
    let rawMwVer = '';
    try {
        rawMwVer = execSync("docker compose exec -T mediawiki php cli/showConfiguration.php --config wgVersion", { encoding: 'utf8' }).trim();
    } catch (e) {
        try {
            rawMwVer = execSync("docker compose exec -T mediawiki php maintenance/showConfiguration.php --config wgVersion", { encoding: 'utf8' }).trim();
        } catch (err) {
            rawMwVer = '';
        }
    }

    if (!rawMwVer || rawMwVer.includes("Could not open")) {
        throw new Error("Could not detect MediaWiki version via CLI scripts.");
    }

    const parts = rawMwVer.split('.');
    const dynamicMwVersion = `REL${parts[0]}_${parts[1]}`;
    console.log(`   🎯 Detected MediaWiki core engine version: ${rawMwVer} (Branch target: ${dynamicMwVersion})`);

    const mwJsonPath = path.join(__dirname, 'mediawiki-plugins.json');
    if (fs.existsSync(mwJsonPath)) {
        const rawJson = fs.readFileSync(mwJsonPath, 'utf8');
        const expandedJson = expandEnvVars(rawJson);
        const mwPlugins = JSON.parse(expandedJson);

        mwPlugins.forEach(plugin => {
            // קריאה ישירה לסקריפט ה-JavaScript החדש שלנו בצורה שווה לווינדוס ולינוקס!
            const extensionScript = path.join(__dirname, 'install-mediawiki-extension.js');
            const settingsArg = Array.isArray(plugin.settings) ? plugin.settings.join(',') : plugin.settings;
            
            runCmd(`node "${extensionScript}" --ExtensionName "${plugin.name}" --MwVersion "${dynamicMwVersion}" --SettingsList "${settingsArg}"`);
        });

        console.log("   [*] Executing MediaWiki database schema updates (update.php)...");
        try {
            runCmd("docker compose exec -T mediawiki php cli/update.php --quick", { stdio: 'ignore' });
        } catch (e) {
            runCmd("docker compose exec -T mediawiki php maintenance/update.php --quick", { stdio: 'ignore' });
        }
        console.log("[+] MediaWiki ecosystem configured successfully!");
    }
} catch (error) {
    console.log(`[-] Warning: MediaWiki asset configuration failed. Reason: ${error.message}`);
}

// ---------------------------------------------------------
// Phase 5: NodeBB Plugin Activation & Asset Compilation
// ---------------------------------------------------------
console.log("\n[5/6] Linking and compiling NodeBB SSO module dynamically...");
try {
    console.log("   [*] Creating development symlink for custom SSO plugin...");
    // 1. נכנסים לתיקיית הפלאגין בתוך הקונטיינר ומבצעים רישום גלובלי
    runCmd("docker compose exec -T nodebb npm link /usr/src/app/custom_plugins/nodebb-plugin-sso-oauth", { stdio: 'ignore' });

    console.log("   [*] Registering local SSO plugin to core array...");
    // 2. מפעילים את הפלאגין בתוך המערכת
    runCmd("docker compose exec -T nodebb ./nodebb activate nodebb-plugin-sso-oauth", { stdio: 'ignore' });
    
    console.log("   [*] Compiling web assets (SCSS & HTML templates)...");
    runCmd("docker compose exec -T nodebb ./nodebb build", { stdio: 'ignore' });
    
    console.log("   [*] Executing soft restart on NodeBB service instance...");
    runCmd("docker compose exec -T nodebb ./nodebb restart", { stdio: 'ignore' });
    console.log("[+] NodeBB instance compiled successfully in Development Mode!");
} catch (error) {
    console.log("[-] Warning: NodeBB compilation failed.");
}

// ---------------------------------------------------------
// Setup Completion Matrix
// ---------------------------------------------------------
console.log("\n[*] [6/6] Corinthian Infrastructure Stack is Online!");
console.log("----------------------------------------------------");
console.log(`Central Archive   : https://${process.env.DOMAIN_ARCHIVE}`);
console.log(`Community Forums  : https://${process.env.DOMAIN_FORUM}`);
console.log(`Knowledge Wiki    : https://${process.env.DOMAIN_WIKI}`);
console.log(`Identity Provider : https://${process.env.DOMAIN_SSO}`);
console.log("====================================================");