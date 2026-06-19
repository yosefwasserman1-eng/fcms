// =====================================================================
// Corinthian Archive - Automated Immutable Setup Pipeline (Node.js)
// =====================================================================
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log("====================================================");
console.log("[*] Starting Automated Deployment (Corinthian Stack)");
console.log("====================================================");

// קריאת הפאזה המבוקשת משורת הפקודה (אם הועברה)
// דוגמה לשימוש: node setup.js --phase=3
const args = process.argv.slice(2);
const phaseArg = args.find(arg => arg.startsWith('--p='));
const targetPhase = phaseArg ? parseInt(phaseArg.split('=')[1], 10) : null;

const ROOT_DIR = path.resolve(__dirname, '..');

function runCmd(command, options = {}) {
    try {
        execSync(command, { cwd: ROOT_DIR, stdio: 'inherit', ...options });
    } catch (error) {
        console.error(`[-] Command failed: ${command}`);
        process.exit(1);
    }
}

function expandEnvVars(text) {
    return text.replace(/\$\{([^}]+)\}/g, (_, envVar) => process.env[envVar] || '');
}

// פונקציית עזר לבדיקה האם לבצע את הפאזה הנוכחית
function shouldRun(phaseNumber) {
    return targetPhase === null || targetPhase === phaseNumber;
}

// ---------------------------------------------------------
// Phase 0: Load Environment Variables & Environment Cleanup
// ---------------------------------------------------------
// פאזה 0 תמיד רצה כדי לטעון משתני סביבה חיוניים, אלא אם כן ביקשת פאזה ספציפית ומדלגים על ה-Cleanup
if (shouldRun(0) || targetPhase !== null) {
    console.log("\n[0/6] Loading network variables and secrets from .env...");
    const envPath = path.join(ROOT_DIR, '.env');

    if (fs.existsSync(envPath)) {
        const envConfig = fs.readFileSync(envPath, 'utf8');
        envConfig.split('\n').forEach(line => {
            const match = line.trim().match(/^(?!#)([^=]+)=(.*)$/);
            if (match) {
                const key = match[1].trim();
                let value = match[2].trim();
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

    // ננקה קונטיינרים ישנים רק אם מריצים את כל הסקריפט מהתחלה
    if (targetPhase === null || targetPhase === 0) {
        console.log("[*] Cleaning up legacy containers and orphaned volumes...");
        runCmd("docker compose down -v", { stdio: 'ignore' });
    }
}

// ---------------------------------------------------------
// Phase 1: Local SSL/TLS Certificate Verification
// ---------------------------------------------------------
if (shouldRun(1)) {
    console.log("\n[1/6] Verifying local SSL/TLS certificates in gateway/cart layer...");
    const GATEWAY_CART = path.join(ROOT_DIR, 'gateway', 'cart');
    const certFile = path.join(GATEWAY_CART, 'cert.pem');
    const keyFile = path.join(GATEWAY_CART, 'key.pem');

    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
        console.log("[*] Certificates missing. Generating new local SSL certs...");
        try {
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
            console.log("[+] Certificates generated successfully!");
        } catch (error) {
            console.error("[-] Error: mkcert generation failed.");
            process.exit(1);
        }
    } else {
        console.log("[+] Active SSL certificates found in gateway/cart. Skipping generation.");
    }

    // קונפיג NodeBB
    const nodebbTemplatePath = path.join(ROOT_DIR, 'content_engines', 'nodebb', 'config', 'config.json.template');
    const nodebbConfigPath = path.join(ROOT_DIR, 'content_engines', 'nodebb', 'config', 'config.json');

    if (fs.existsSync(nodebbTemplatePath)) {
        console.log("[*] Generating dynamic NodeBB config.json...");
        const nodebbTemplateText = fs.readFileSync(nodebbTemplatePath, 'utf8');
        fs.writeFileSync(nodebbConfigPath, expandEnvVars(nodebbTemplateText), 'utf8');
    }
}

// ---------------------------------------------------------
// Phase 2: Docker Cacheless Build & Orchestration
// ---------------------------------------------------------
if (shouldRun(2)) {
    console.log("\n[2/6] Building clean containers and initializing databases...");
    runCmd("docker compose build --no-cache");
    runCmd("docker compose up -d db nodebb-db");
    
    console.log("[*] Waiting 15 seconds for database initialization...");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15000);

    runCmd("docker compose up -d");
    console.log("[*] Waiting 20 seconds for core platforms to boot up...");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20000);
}

// ---------------------------------------------------------
// Phase 3: WordPress Automated Configuration
// ---------------------------------------------------------
if (shouldRun(3)) {
    console.log("\n[3/6] Configuring WordPress plugins and options...");
    runCmd("docker exec -it c_wordpress update-ca-certificates");

    console.log("[*] Checking if WP-CLI is already installed inside c_wordpress...");
    let isWpCliInstalled = false;
    try {
        execSync(`docker exec c_wordpress which wp`, { stdio: 'pipe' });
        isWpCliInstalled = true;
    } catch (e) {
        isWpCliInstalled = false;
    }

    if (!isWpCliInstalled) {
        console.log("[*] WP-CLI not found. Starting installation process...");
        runCmd(`docker exec -u root c_wordpress curl -O https://raw.githubusercontent.com/wp-cli/builds/gh-pages/phar/wp-cli.phar`, { stdio: 'inherit' });

        console.log("[*] Setting executable permissions...");
        runCmd(`docker exec -u root c_wordpress chmod +x wp-cli.phar`, { stdio: 'inherit' });

        console.log("[*] Moving WP-CLI to global binary path...");
        runCmd(`docker exec -u root c_wordpress mv wp-cli.phar /usr/local/bin/wp`, { stdio: 'inherit' });
        console.log("[+] WP-CLI installed successfully!");
    } else {
        console.log("[+] WP-CLI is already installed. Skipping installation phase.");
    }

    console.log("[*] Running automated WordPress core installation...");
    runCmd(`docker exec -u www-data c_wordpress wp core install --url="${process.env.DOMAIN_ARCHIVE}" --title="Corinthian Archive" --admin_user="admin" --admin_password="admin_password" --admin_email="admin@example.com" --skip-email`);
    try {
        const wpJsonPath = path.join(__dirname, 'wordpress-plugins.json');
        if (fs.existsSync(wpJsonPath)) {
            const wpPlugins = JSON.parse(expandEnvVars(fs.readFileSync(wpJsonPath, 'utf8')));
            wpPlugins.forEach(plugin => {          
                runCmd(`docker exec -u www-data c_wordpress wp plugin install ${plugin.slug} --force --activate`);           
                const mainOptionName = Object.keys(plugin.options)[0];
                const innerKeys = Object.entries(plugin.options[mainOptionName]);

                try {
                    execSync(`docker exec -u www-data c_wordpress wp option get "${mainOptionName}"`, { stdio: 'ignore' });
                } catch (e) {
                    execSync(`docker exec -u www-data c_wordpress wp option add "${mainOptionName}" "{}" --format=json`, { stdio: 'ignore' });
                }

                innerKeys.forEach(([key, value]) => {
                    try {
                        execSync(`docker exec -u www-data c_wordpress wp option patch update ${mainOptionName} ${key} "${value}"`, { stdio: 'ignore' });
                    } catch (err) {
                        console.log(`[*] Option ${key} not found in ${mainOptionName}. Adding it now...`);
                        execSync(`docker exec -u www-data c_wordpress wp option patch insert ${mainOptionName} ${key} "${value}"`, { stdio: 'ignore' });
                    }
                });
            });
            console.log("[+] WordPress environment setup completed!");
        }
    } catch (error) {
        console.log(`[-] Warning: WordPress automation failed: ${error.message}`);
    }
}

// ---------------------------------------------------------
// Phase 4: MediaWiki Dynamic Installation
// ---------------------------------------------------------
if (shouldRun(4)) {
    console.log("\n[4/6] Initializing MediaWiki extension compiler...");
    try {
        let rawMwVer = '1.42.0';
        try {
            rawMwVer = execSync("docker exec c_mediawiki php -r 'define(\"MEDIAWIKI\", true); include \"/var/www/html/includes/WebStart.php\"; global $wgVersion; echo $wgVersion;' 2>/dev/null", { encoding: 'utf8' }).trim();
        } catch (e) {}

        const parts = rawMwVer.split('.');
        const dynamicMwVersion = `REL${parts[0]}_${parts[1]}`;

        const mwJsonPath = path.join(__dirname, 'mediawiki-plugins.json');
        if (fs.existsSync(mwJsonPath)) {
            const mwPlugins = JSON.parse(expandEnvVars(fs.readFileSync(mwJsonPath, 'utf8')));
            mwPlugins.forEach(plugin => {
                const extensionScript = path.join(__dirname, 'install-mediawiki-extension.js');
                const settingsArg = Array.isArray(plugin.settings) ? plugin.settings.join(',') : plugin.settings;
                runCmd(`node "${extensionScript}" --ExtensionName "${plugin.name}" --MwVersion "${dynamicMwVersion}" --SettingsList "${settingsArg}"`);
            });

            try {
                execSync("docker exec -u www-data c_mediawiki php /var/www/html/maintenance/run.php update --quick", { stdio: 'ignore' });
            } catch (e) {
                try { execSync("docker exec -u www-data c_mediawiki php /var/www/html/maintenance/update.php --quick", { stdio: 'ignore' }); } catch (err) {}
            }
            console.log("[+] MediaWiki ecosystem configured successfully!");
        }
    } catch (error) {
        console.log(`[-] Warning: MediaWiki configuration failed: ${error.message}`);
    }
}

// ---------------------------------------------------------
// Phase 5: NodeBB Plugin Activation & Asset Compilation
// ---------------------------------------------------------
if (shouldRun(5)) {
    console.log("\n[5/6] Linking and compiling NodeBB SSO module dynamically...");
    try {
        execSync('docker exec c_nodebb ./nodebb setup', {
            stdio: 'inherit',
            env: {
                ...process.env,
                'setup__url': `https://${process.env.DOMAIN_FORUM}`,
                'setup__admin:username': 'admin',
                'setup__admin:password': 'admin',
                'setup__admin:password:confirm': 'admin',
                'setup__admin:email': `admin@${process.env.DOMAIN_FORUM}`
            }
        });
    } catch (e) {}

    try {
        runCmd("docker exec -u root c_nodebb npm link /usr/src/app/custom_plugins/nodebb-plugin-sso-oauth");
        runCmd("docker exec c_nodebb ./nodebb activate nodebb-plugin-sso-oauth");
        runCmd("docker exec c_nodebb ./nodebb build");
        runCmd("docker exec c_nodebb ./nodebb restart");
        console.log("[+] NodeBB instance compiled successfully!");
    } catch (error) {
        console.log("[-] Warning: NodeBB compilation failed.");
    }
}

// ---------------------------------------------------------
// Setup Completion Matrix
// ---------------------------------------------------------
console.log("\n[*] [6/6] Corinthian Infrastructure Stack Status Matrix Updated!");
console.log(`Central Archive   : https://${process.env.DOMAIN_ARCHIVE}`);
console.log(`Community Forums  : https://${process.env.DOMAIN_FORUM}`);
console.log(`Knowledge Wiki    : https://${process.env.DOMAIN_WIKI}`);
console.log(`Identity Provider : https://${process.env.DOMAIN_SSO}`);
console.log("====================================================");