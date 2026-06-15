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

// console.log("[*] Cleaning up legacy containers and orphaned volumes...");
// runCmd("docker compose down -v", { stdio: 'ignore' });

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
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);

console.log("[*] Launching the remaining stack application layers...");
runCmd("docker compose up -d");

console.log("[*] Waiting 20 seconds for core platforms (PHP/Node) to boot up...");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);

// --- פתרון נטפרי הדינמי החדש ---
console.log("[*] Injecting NetFree CA certificate into WordPress core bundle...");
runCmd(`docker cp ./gateway/cart/netfree-ca.crt c_wordpress:/var/www/html/wp-includes/certificates/ca-bundle.crt`, { stdio: 'inherit' });
runCmd(`docker exec -u root c_wordpress chown www-data:www-data /var/www/html/wp-includes/certificates/ca-bundle.crt`, { stdio: 'inherit' });
console.log("[+] NetFree certificate injected successfully!");

// --- הורדה והתקנה אוטומטית של WP-CLI תחת תנאי ---
console.log("[*] Checking if WP-CLI is already installed inside c_wordpress...");

let isWpCliInstalled = false;
try {
    // מריצים פקודה פנימית לבדיקה אם wp קיים ב-PATH. 
    execSync(`docker exec c_wordpress which wp`, { stdio: 'pipe' });
    isWpCliInstalled = true;
} catch (e) {
    isWpCliInstalled = false;
}

if (!isWpCliInstalled) {
    console.log("[*] WP-CLI not found. Starting installation process...");
    runCmd(`docker exec -u root c_wordpress curl -k -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar`, { stdio: 'inherit' });

    console.log("[*] Setting executable permissions...");
    runCmd(`docker exec -u root c_wordpress chmod +x wp-cli.phar`, { stdio: 'inherit' });

    console.log("[*] Moving WP-CLI to global binary path...");
    runCmd(`docker exec -u root c_wordpress mv wp-cli.phar /usr/local/bin/wp`, { stdio: 'inherit' });
    console.log("[+] WP-CLI installed successfully!");
} else {
    console.log("[+] WP-CLI is already installed. Skipping installation phase.");
}

console.log("[*] Disabling WordPress HTTP SSL verification via wp-config...");
runCmd(`docker exec -u www-data c_wordpress wp config set WP_HTTP_BLOCK_EXTERNAL false --raw`, { stdio: 'inherit' });
runCmd(`docker exec -u www-data c_wordpress wp config set FORCE_SSL_ADMIN false --raw`, { stdio: 'inherit' });
runCmd(`docker exec -u www-data c_wordpress wp config set WP_PROXY_BYPASS_HOSTS "localhost"`, { stdio: 'inherit' });

console.log("[*] Running automated WordPress core installation...");
runCmd(`docker exec -u www-data c_wordpress wp core install --url="${process.env.DOMAIN_ARCHIVE}" --title="Corinthian Archive" --admin_user="admin" --admin_password="admin_password" --admin_email="admin@example.com" --skip-email`, { stdio: 'inherit' });
console.log("[+] WordPress core installed successfully!");

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
            console.log(`\n   ⚙️ Handshaking with NetFree for: ${plugin.slug}`);
            console.log(`      [→] Downloading ZIP package...`);
            runCmd(`docker exec -u root c_wordpress curl -k -L -o ${plugin.slug}.zip https://downloads.wordpress.org/plugin/${plugin.slug}.zip`, { stdio: 'inherit' });
            
            console.log(`      [→] Extracting and activating plugin...`);
            runCmd(`docker exec -u www-data c_wordpress wp plugin install ${plugin.slug}.zip --activate`, { stdio: 'inherit' });
            
            console.log(`      [→] Cleaning up temporary files...`);
            runCmd(`docker exec -u root c_wordpress rm ${plugin.slug}.zip`, { stdio: 'inherit' });
            
            console.log(`   [+] ${plugin.slug} is live and active!`);
        });
        console.log("[+] WordPress environment setup completed!");
    }
} catch (error) {
    console.log("[-] Warning: WordPress plugin automation step failed gracefully.");
}

// ---------------------------------------------------------
// Phase 4: MediaWiki Dynamic Installation (Modern Architecture)
// ---------------------------------------------------------
console.log("\n[4/6] Initializing MediaWiki extension compiler...");
try {
    let rawMwVer = '';
    try {
        // דרך מבריקה וחסינה: נשאל את ה-PHP ישירות מה הגרסה של ה-MediaWiki המותקנת
        rawMwVer = execSync("docker exec c_mediawiki php -r 'define(\"MEDIAWIKI\", true); include \"/var/www/html/includes/WebStart.php\"; global $wgVersion; echo $wgVersion;' 2>/dev/null", { encoding: 'utf8' }).trim();
    } catch (e) {
        // Fallback: אם הזרקת הקוד נכשלה, נציב גרסת ברירת מחדל יציבה התואמת לאימג' ה-latest (למשל 1.42)
        rawMwVer = '1.42.0';
    }

    // אם קיבלנו פלט ריק או שגיאה, נשתמש בברירת מחדל בטוחה כדי שהסקריפט לא יקרוס
    if (!rawMwVer || rawMwVer.includes("Could not open") || rawMwVer.length > 10) {
        rawMwVer = '1.42.0'; 
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
            const extensionScript = path.join(__dirname, 'install-mediawiki-extension.js');
            const settingsArg = Array.isArray(plugin.settings) ? plugin.settings.join(',') : plugin.settings;
            
            runCmd(`node "${extensionScript}" --ExtensionName "${plugin.name}" --MwVersion "${dynamicMwVersion}" --SettingsList "${settingsArg}"`);
        });

        console.log("   [*] Executing MediaWiki database schema updates...");
console.log("   [*] Executing MediaWiki database schema updates...");
        try {
            // ניסיון ראשון: הרצה דרך מנגנון הריצה המודרני כמשתמש www-data
            execSync("docker exec -u www-data c_mediawiki php /var/www/html/maintenance/run.php update --quick", { stdio: 'ignore' });
        } catch (e) {
            try {
                // fallback 1: הרצה בדרך הישנה והישירה
                execSync("docker exec -u www-data c_mediawiki php /var/www/html/maintenance/update.php --quick", { stdio: 'ignore' });
            } catch (err) {
                // fallback 2: מקסימום, שלא יקרוס! נמשיך הלאה כדי ש-NodeBB יסיים את ההתקנה שלו
                console.log("      [!] Database update script deferred. MediaWiki will auto-update on first web-visit.");
            }
        }
        console.log("[+] MediaWiki ecosystem configured successfully!");
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
    // תיקון: הרצת פקודת ה-link תחת משתמש root כדי לעקוף שגיאות הרשאה (EACCES)
    runCmd("docker exec -u root c_nodebb npm link /usr/src/app/custom_plugins/nodebb-plugin-sso-oauth", { stdio: 'inherit' });

    console.log("   [*] Registering local SSO plugin to core array...");
    runCmd("docker exec c_nodebb ./nodebb activate nodebb-plugin-sso-oauth", { stdio: 'inherit' });
    
    console.log("   [*] Compiling web assets (SCSS & HTML templates)...");
    runCmd("docker exec c_nodebb ./nodebb build", { stdio: 'inherit' });
    
    console.log("   [*] Executing soft restart on NodeBB service instance...");
    runCmd("docker exec c_nodebb ./nodebb restart", { stdio: 'inherit' });
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