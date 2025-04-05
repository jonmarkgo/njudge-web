require('dotenv').config();
const express = require('express');
const path = require('path');
const { exec } = require('child_process');
const session = require('express-session'); // Import express-session

const app = express();
const port = process.env.PORT || 3000;
const dipBinaryPath = process.env.DIP_BINARY_PATH || './dip';
const sessionSecret = process.env.SESSION_SECRET;

if (!sessionSecret || sessionSecret === 'your-very-secret-key') {
    console.warn('\n!!! WARNING: SESSION_SECRET is not set or is using the default value in .env !!!');
    console.warn('!!! Please set a strong, random secret for session management in production. !!!\n');
    // In a real app, you might exit here or generate a temporary secret
}

// --- Middleware ---
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Session Configuration
app.use(session({
    secret: sessionSecret || 'fallback-secret', // Use secret from .env or a fallback
    resave: false, // Don't save session if unmodified
    saveUninitialized: false, // Don't create session until something stored
    cookie: {
        secure: false, // Set to true if using HTTPS
        httpOnly: true, // Helps prevent XSS
        maxAge: 1000 * 60 * 60 * 24 // Example: 1 day session duration
    }
    // In production, consider using a persistent session store like connect-redis or connect-mongo
}));

// Middleware to ensure email is in session for protected routes
function requireEmail(req, res, next) {
    if (!req.session.email) {
        return res.redirect('/');
    }
    next();
}

// Middleware to ensure user is signed on for game commands
function requireSignedOn(req, res, next) {
    if (!req.session.signedOnGame || !req.session.signedOnPower) {
         // Send an error or redirect, maybe back to dashboard
         // For API calls, sending JSON error is better
        if (req.path.startsWith('/execute-dip')) {
             return res.status(403).json({ success: false, output: 'Error: You must be signed on to a game/power to execute this command.' });
        } else {
            // For page loads, redirect
            return res.redirect('/dashboard');
        }
    }
    next();
}


// --- Routes ---

// Root route: Show email entry form
app.get('/', (req, res) => {
    // If already logged in (has email in session), redirect to dashboard
    if (req.session.email) {
        return res.redirect('/dashboard');
    }
    res.render('index'); // Render index.ejs (email form)
});

// Handle email submission
app.post('/start', (req, res) => {
    const email = req.body.email;
    if (!email || !email.includes('@')) {
        return res.render('index', { error: 'Please enter a valid email address.' });
    }
    // Store email in session
    req.session.email = email;
    req.session.signedOnGame = null; // Ensure not signed on initially
    req.session.signedOnPower = null;
    // Redirect to the main dashboard
    res.redirect('/dashboard');
});

// Main dashboard route
app.get('/dashboard', requireEmail, (req, res) => {
    if (req.session.signedOnGame && req.session.signedOnPower) {
        // If signed on, render the main interface
        res.render('interface', {
            email: req.session.email,
            game: req.session.signedOnGame,
            power: req.session.signedOnPower
        });
    } else {
        // If not signed on, render the sign-on/register options page
        res.render('signon', { email: req.session.email });
    }
});

// Sign off route
app.post('/signoff', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Session destruction error:", err);
            // Handle error appropriately, maybe send an error page
            return res.status(500).send("Could not log out.");
        }
        res.redirect('/'); // Redirect to the home page (email entry)
    });
});


// API endpoint to execute the dip command
// Apply requireEmail middleware here so we know req.session.email exists
app.post('/execute-dip', requireEmail, (req, res) => {
    const { command } = req.body; // Email now comes from session
    const email = req.session.email;

    if (!command) {
        return res.status(400).json({ success: false, output: 'Error: Missing command.' });
    }

    // --- Command Authorization ---
    const commandVerb = command.trim().split(' ')[0].toUpperCase();
    const allowedPreSignInCommands = [
        'REGISTER', 'WHOIS', 'INFO', 'GET', 'VERSION', 'HELP', 'LIST', 'HISTORY', 'SUMMARY', 'WHOGAME',
        'SIGN', // Catches SIGN ON ?, SIGN ON ?game, SIGN ON power
        'OBSERVE', 'WATCH'
    ];
    const requiresSignIn = !allowedPreSignInCommands.some(prefix => commandVerb.startsWith(prefix));

    if (requiresSignIn && (!req.session.signedOnGame || !req.session.signedOnPower)) {
         return res.status(403).json({ success: false, output: 'Error: You must be signed on to a game/power to execute this command.' });
    }
    // --- End Command Authorization ---


    const sanitizedCommand = command.replace(/[`;&|!$()<>]/g, ''); // Example basic sanitization
  
    const now = new Date();
  
  // Output example: Sat, 05 Apr 2025 14:30:45 GMT
  // Construct the input for the dip binary, simulating an email body
  // Add REPLY-TO header and SIGN OFF command as per manual recommendations
  const dipInput = `FROM: ${email}\nTO: jonmarkgodiplomacyjudge@gmail.com\nSubject: njudge-web via ${email}\nDate: ${now.toUTCString()}\n\n${sanitizedCommand}\n`;
    const escapedInput = dipInput.replace(/"/g, '\\"');
    const commandToExecute = `echo "${escapedInput}" | ${dipBinaryPath}`;

    console.log(`User ${email} executing: ${commandToExecute}`);

    exec(commandToExecute, { timeout: 15000 }, (error, stdout, stderr) => { // Increased timeout slightly
        console.log(`Stdout for ${email}:\n${stdout}`);
        console.error(`Stderr for ${email}:\n${stderr}`);

        const output = `--- stdout ---\n${stdout}\n\n--- stderr ---\n${stderr}`;
        let isSignOnSuccess = false;

        // --- Special Handling for SIGN ON power ---
        // This parsing is FRAGILE and depends heavily on dip's output format
        if (commandVerb === 'SIGN' && command.includes('ON') && !command.includes('?')) {
             // Attempt to parse game and power from the command itself
             // Example: SIGN ON Fmygame password
             const parts = command.trim().split(/\s+/);
             let potentialPowerGame = '';
             if (parts.length >= 3 && parts[0].toUpperCase() === 'SIGN' && parts[1].toUpperCase() === 'ON') {
                 potentialPowerGame = parts[2]; // e.g., Fmygame
             }

             // Basic success check: No error object from exec, and stderr is empty or informational
             if (!error && (!stderr || stderr.trim().length === 0 || stderr.toLowerCase().includes("warning:"))) {
                 // More specific check (highly dependent on actual dip output)
                 // Example: Look for "Signed on as France in game mygame" or similar
                 const successPattern = /signed on as (\w+)\s*(?:in game)?\s*'(\w+)'/i; // Adjust regex as needed!
                 const match = stdout.match(successPattern);

                 if (match) {
                     const signedOnPower = match[1]; // Extracted power
                     const signedOnGame = match[2]; // Extracted game

                     // Check if it matches the intended sign-on
                     // potentialPowerGame might be 'Fmygame' - need to compare carefully
                     if (potentialPowerGame.length > 1 &&
                         potentialPowerGame.startsWith(signedOnPower[0].toUpperCase()) &&
                         potentialPowerGame.endsWith(signedOnGame))
                     {
                         console.log(`SIGN ON Success detected for ${email}: Game=${signedOnGame}, Power=${signedOnPower}`);
                         req.session.signedOnGame = signedOnGame;
                         req.session.signedOnPower = signedOnPower;
                         isSignOnSuccess = true;
                     } else {
                         console.warn(`SIGN ON output parsed (${signedOnPower}/${signedOnGame}), but didn't match command input (${potentialPowerGame}) for ${email}`);
                     }
                 } else {
                     // Fallback: Assume success if no errors and stdout looks reasonable (e.g., contains game name)
                     // This is less reliable.
                     if (potentialPowerGame.length > 1 && stdout.includes(potentialPowerGame.substring(1))) {
                         console.warn(`SIGN ON Success assumed (fallback) for ${email}: Game=${potentialPowerGame.substring(1)}, Power=${potentialPowerGame[0]}. Output parsing needs refinement.`);
                         req.session.signedOnGame = potentialPowerGame.substring(1); // Extract game from Fmygame
                         req.session.signedOnPower = potentialPowerGame[0];      // Extract power from Fmygame
                         isSignOnSuccess = true;
                     } else {
                          console.log(`SIGN ON for ${email} completed without errors, but success message not recognized in output.`);
                     }
                 }
             } else {
                 console.log(`SIGN ON failed for ${email}. Error: ${error}, Stderr: ${stderr}`);
                 // Ensure session state is cleared if sign-on fails
                 req.session.signedOnGame = null;
                 req.session.signedOnPower = null;
             }
        }
        // --- End Special Handling ---


        if (error) {
            console.error(`Execution Error for ${email}: ${error.message}`);
            return res.status(500).json({
                success: false,
                output: `Execution failed: ${error.message}\n\n${output}`, // Include stdout/stderr
                isSignOnSuccess: false // Explicitly false on error
            });
        }

        // Send response
        res.json({
            success: true, // Indicates the command executed without node/exec errors
            output: output,
            isSignOnSuccess: isSignOnSuccess // Specific flag for UI handling
        });
    });
});

// --- Start Server ---
app.listen(port, () => {
    console.log(`Dip Web App listening at http://localhost:${port}`);
    console.log(`Using dip binary path: ${dipBinaryPath}`);
    // Check binary existence/permissions (same as before)
    const fs = require('fs');
    if (!fs.existsSync(dipBinaryPath)) {
        console.warn(`\nWARNING: Dip binary not found at '${dipBinaryPath}'. Check .env and permissions (chmod +x ${dipBinaryPath}).\n`);
    } else {
        try {
            fs.accessSync(dipBinaryPath, fs.constants.X_OK);
            console.log(`Dip binary found and appears executable.`);
        } catch (err) {
            console.warn(`\nWARNING: Dip binary found at '${dipBinaryPath}' but might not be executable. Try: chmod +x ${dipBinaryPath}\n`);
        }
    }
});