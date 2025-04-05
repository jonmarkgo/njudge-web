document.addEventListener('DOMContentLoaded', () => {
    const commandTypeSelect = document.getElementById('command-type');
    const optionsArea = document.getElementById('command-options-area');
    const generatedCommandTextarea = document.getElementById('generated-command');
    const sendButton = document.getElementById('send-command');
    const outputDiv = document.getElementById('output');
    // No email input needed here anymore, it's handled by the server session

    // --- Command Generator Logic ---
    // (Keep the existing generator logic, but add/modify cases as needed
    // for the commands available on signon.ejs vs interface.ejs)

    if (commandTypeSelect) { // Check if the select element exists on the page
        commandTypeSelect.addEventListener('change', () => {
            const selectedCommand = commandTypeSelect.value;
            optionsArea.innerHTML = ''; // Clear previous options
            generatedCommandTextarea.value = ''; // Clear textarea

            // --- Add cases for REGISTER, OBSERVE, MANUAL etc. for signon.ejs ---
            switch (selectedCommand) {
                case 'REGISTER':
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <p>Enter registration details below, one field per line (e.g., Name: John Doe). End with END.</p>
                            <textarea id="register-body" rows="6" placeholder="Name: Your Name\nAddress: Your City, Country\nEmail: you@example.com\nLevel: Novice\n...\nEND"></textarea>
                        </div>`;
                     break;
                case 'OBSERVE':
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="observe-game">Game Name:</label>
                            <input type="text" id="observe-game" required placeholder="e.g., watchgame">
                            <label for="observe-password">Password:</label>
                            <input type="password" id="observe-password" required>
                        </div>`;
                     break;
                 case 'MANUAL':
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <p>Enter the full command manually in the text area below.</p>
                        </div>`;
                     generatedCommandTextarea.placeholder = "Type full command here (e.g., WHOIS someone@example.com)";
                     break;

                // --- Keep/Modify existing cases like LIST, SIGN ON variations, GET, WHOIS ---
                case 'LIST':
                    // Check if we are on the interface page (game context) or signon page
                    const gameInput = document.querySelector('input[name="currentGame"]'); // Assuming you add this if needed
                    const defaultGame = gameInput ? gameInput.value : '';
                    optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="list-game-name">Game Name (optional, defaults to current game if signed in):</label>
                            <input type="text" id="list-game-name" placeholder="e.g., mygame" value="${defaultGame}">
                            <label for="list-full">Full List?</label>
                            <input type="checkbox" id="list-full">
                        </div>`;
                    break;
                case 'HISTORY':
                case 'SUMMARY':
                case 'WHOGAME':
                     const cmdLower = selectedCommand.toLowerCase();
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="${cmdLower}-game-name">Game Name (required, defaults to current if signed in):</label>
                            <input type="text" id="${cmdLower}-game-name" required>
                            ${selectedCommand === 'HISTORY' ? `
                                <label for="hist-from">From Date (optional):</label>
                                <input type="text" id="hist-from" placeholder="e.g., Jan 1 2023 or S1901M">
                                <label for="hist-to">To Date (optional):</label>
                                <input type="text" id="hist-to" placeholder="e.g., Dec 31 2023 or F1905B">
                                <label for="hist-lines">Max Lines (optional):</label>
                                <input type="number" id="hist-lines" placeholder="e.g., 5000">
                                <label for="hist-exclstart">EXCLSTART turnId:</label>
                                <input type="text" id="hist-exclstart" placeholder="e.g., S1903M">
                                <label for="hist-exclend">EXCLEND turnId:</label>
                                <input type="text" id="hist-exclend" placeholder="e.g., F1905B">
                                <label for="hist-broad">Include Broadcasts (with EXCL)?</label>
                                <input type="checkbox" id="hist-broad">
                            ` : ''}
                             ${selectedCommand === 'WHOGAME' ? `
                                <label for="whogame-full">Include Observers (FULL)?</label>
                                <input type="checkbox" id="whogame-full">
                             ` : ''}
                        </div>`;
                    break;
                case 'SIGN ON power':
                    optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="signon-power">Power Initial:</label>
                            <input type="text" id="signon-power" size="1" maxlength="1" required placeholder="e.g., F">
                            <label for="signon-game">Game Name:</label>
                            <input type="text" id="signon-game" required placeholder="e.g., mygame">
                            <label for="signon-password">Password:</label>
                            <input type="password" id="signon-password" required>
                        </div>`;
                    break;
                 case 'SIGN ON ?game':
                    optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="signon-q-game">Game Name:</label>
                            <input type="text" id="signon-q-game" required placeholder="e.g., forminggame">
                            <label for="signon-q-password">Password:</label>
                            <input type="password" id="signon-q-password" required>
                            <label for="signon-q-variant">Variant/Options (optional):</label>
                            <input type="text" id="signon-q-variant" placeholder="e.g., Chaos Gunboat">
                        </div>`;
                    break;
                case 'SIGN ON ?':
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="signon-?-password">Password:</label>
                            <input type="password" id="signon-?-password" required>
                        </div>`;
                    break;
                case 'ORDERS':
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <p>Enter orders directly into the text area below.</p>
                            <p>Example: <code>A Par H</code>, <code>F Lon - Nth</code>, <code>A Mun S A Ber - Sil</code></p>
                            <p>Separate multiple orders with newlines or commas.</p>
                        </div>`;
                     break;
                case 'PRESS':
                case 'BROADCAST':
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="press-options">Press Options (e.g., TO FRG, GREY, FAKE TO A):</label>
                            <input type="text" id="press-options" placeholder="e.g., TO AET">
                            <label for="press-body">Press Message Body:</label>
                            <textarea id="press-body" rows="4" required></textarea>
                            <p>Command will be assembled as: ${selectedCommand} [options]\\n[body]\\nENDPRESS</p>
                        </div>`;
                     break;
                case 'GET':
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="get-filename">Filename:</label>
                            <input type="text" id="get-filename" required placeholder="e.g., info, rules, map">
                        </div>`;
                     break;
                 case 'WHOIS':
                     optionsArea.innerHTML = `
                        <div class="command-options">
                            <label for="whois-email">Email Address (or start of):</label>
                            <input type="text" id="whois-email" required placeholder="e.g., user@ or user@domain.com">
                        </div>`;
                     break;
                // Add more cases here for other commands...
                default:
                    optionsArea.innerHTML = `<div class="command-options"><p>Enter command parameters directly in the text area below.</p></div>`;
                    generatedCommandTextarea.value = selectedCommand + ' ';
                    break;
            }

            // Add event listeners to update the textarea as options change
            optionsArea.querySelectorAll('input, select, textarea').forEach(el => {
                el.addEventListener('input', updateGeneratedCommand);
                el.addEventListener('change', updateGeneratedCommand);
            });
            updateGeneratedCommand(); // Initial update
        });
    } // end if(commandTypeSelect)

    function updateGeneratedCommand() {
        const selectedCommand = commandTypeSelect?.value; // Use optional chaining
        if (!selectedCommand) return;

        let commandString = selectedCommand;

        switch (selectedCommand) {
             case 'REGISTER':
                 const registerBody = document.getElementById('register-body')?.value;
                 commandString = `REGISTER\n${registerBody || '<details>\nEND'}`;
                 // Don't automatically add END if user typed it
                 if (registerBody && !registerBody.trim().endsWith('END')) {
                     commandString += '\nEND';
                 }
                 break;
            case 'OBSERVE':
                 const observeGame = document.getElementById('observe-game')?.value.trim();
                 const observePass = document.getElementById('observe-password')?.value;
                 if (observeGame && observePass) {
                     commandString = `OBSERVE ${observeGame} ${observePass}`;
                 } else {
                     commandString = 'OBSERVE <game> <password>';
                 }
                 break;
            case 'LIST':
                const gameNameList = document.getElementById('list-game-name')?.value.trim();
                const fullList = document.getElementById('list-full')?.checked;
                commandString = 'LIST';
                if (gameNameList) {
                    commandString += ` ${gameNameList}`;
                } else if (fullList) {
                    // Only add FULL if no specific game name is given
                    commandString += ' FULL';
                }
                break;
            case 'HISTORY':
            case 'SUMMARY':
            case 'WHOGAME':
                 const cmdLower = selectedCommand.toLowerCase();
                 const gameNameHist = document.getElementById(`${cmdLower}-game-name`)?.value.trim();
                 if (gameNameHist) {
                     commandString = `${selectedCommand} ${gameNameHist}`;
                     if (selectedCommand === 'HISTORY') {
                         const fromDate = document.getElementById('hist-from')?.value.trim();
                         const toDate = document.getElementById('hist-to')?.value.trim();
                         const lines = document.getElementById('hist-lines')?.value.trim();
                         const exclStart = document.getElementById('hist-exclstart')?.value.trim();
                         const exclEnd = document.getElementById('hist-exclend')?.value.trim();
                         const broad = document.getElementById('hist-broad')?.checked;
                         if (exclStart) {
                             commandString += ` EXCLSTART ${exclStart}`;
                             if (exclEnd) commandString += ` EXCLEND ${exclEnd}`;
                             if (broad) commandString += ` BROAD`;
                         } else {
                             if (fromDate) commandString += ` FROM ${fromDate}`;
                             if (toDate) commandString += ` TO ${toDate}`;
                             if (lines) commandString += ` LINES ${lines}`;
                         }
                     } else if (selectedCommand === 'WHOGAME') {
                         const fullWhogame = document.getElementById('whogame-full')?.checked;
                         if (fullWhogame) commandString += ' FULL';
                     }
                 } else {
                     commandString = `${selectedCommand} <game_name_required>`;
                 }
                 break;
            case 'SIGN ON power':
                const power = document.getElementById('signon-power')?.value.trim().toUpperCase();
                const gameP = document.getElementById('signon-game')?.value.trim();
                const passP = document.getElementById('signon-password')?.value;
                if (power && gameP && passP) {
                    commandString = `SIGN ON ${power}${gameP} ${passP}`;
                } else {
                    commandString = 'SIGN ON <P><game> <password>';
                }
                break;
             case 'SIGN ON ?game':
                const gameQ = document.getElementById('signon-q-game')?.value.trim();
                const passQ = document.getElementById('signon-q-password')?.value;
                const variantQ = document.getElementById('signon-q-variant')?.value.trim();
                 if (gameQ && passQ) {
                    commandString = `SIGN ON ?${gameQ} ${passQ}`;
                    if (variantQ) commandString += ` ${variantQ}`;
                 } else {
                    commandString = 'SIGN ON ?<game> <password> [variant]';
                 }
                 break;
            case 'SIGN ON ?':
                const passNext = document.getElementById('signon-?-password')?.value;
                if (passNext) {
                    commandString = `SIGN ON ? ${passNext}`;
                } else {
                    commandString = 'SIGN ON ? <password>';
                }
                break;
            case 'PRESS':
            case 'BROADCAST':
                const pressOpts = document.getElementById('press-options')?.value.trim();
                const pressBody = document.getElementById('press-body')?.value;
                commandString = selectedCommand;
                if (pressOpts) commandString += ` ${pressOpts}`;
                if (pressBody) {
                    commandString += `\n${pressBody}\nENDPRESS`;
                } else {
                     commandString += '\n<message body>\nENDPRESS';
                }
                break;
             case 'GET':
                const filename = document.getElementById('get-filename')?.value.trim();
                if (filename) {
                    commandString = `GET ${filename}`;
                } else {
                    commandString = 'GET <filename>';
                }
                break;
             case 'WHOIS':
                const whoisEmail = document.getElementById('whois-email')?.value.trim();
                 if (whoisEmail) {
                    commandString = `WHOIS ${whoisEmail}`;
                 } else {
                    commandString = 'WHOIS <email>';
                 }
                 break;
            case 'ORDERS':
                commandString = generatedCommandTextarea.value;
                return;
            case 'MANUAL':
                 // Let user type freely, don't prepend command
                 commandString = generatedCommandTextarea.value;
                 return;
            default:
                 // For commands without specific UI, allow manual editing
                 if (!generatedCommandTextarea.value.startsWith(selectedCommand)) {
                     generatedCommandTextarea.value = commandString + ' ';
                 }
                 return;
        }

        if (selectedCommand !== 'ORDERS' && selectedCommand !== 'MANUAL' && selectedCommand !== 'REGISTER') {
             generatedCommandTextarea.value = commandString;
        } else if (selectedCommand === 'REGISTER') {
             // Handle textarea update specifically for multiline REGISTER
             generatedCommandTextarea.value = commandString;
        }
    }


    // --- Send Command Logic ---

    if (sendButton) { // Check if button exists
        sendButton.addEventListener('click', async () => {
            const command = generatedCommandTextarea.value.trim();
            // Email is handled server-side via session now

            if (!command) {
                outputDiv.textContent = 'Error: Command cannot be empty.';
                return;
            }

            outputDiv.textContent = 'Sending command...';
            sendButton.disabled = true;

            try {
                const response = await fetch('/execute-dip', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    // No need to send email in body, server gets it from session
                    body: JSON.stringify({ command }),
                });

                const result = await response.json(); // Expect JSON response

                // Display raw output regardless of success status
                 outputDiv.textContent = result.output || 'No output received.';

                if (response.ok) {
                     // Check for specific sign-on success
                    if (result.isSignOnSuccess) {
                        outputDiv.textContent += '\n\nSign On Successful! Reloading dashboard...';
                        // Reload the page to get the correct view (interface.ejs)
                        setTimeout(() => {
                            window.location.href = '/dashboard'; // Or simply window.location.reload();
                        }, 1500); // Short delay to allow reading the message
                    } else if (command.toUpperCase().startsWith('SIGN ON') && !command.includes('?')) {
                        // If it was a sign on attempt but didn't succeed
                         outputDiv.textContent += '\n\nSign On attempt finished. Check output for success/failure.';
                    }
                } else {
                    // Handle HTTP errors (like 403 Forbidden, 500 Internal Server Error)
                    outputDiv.textContent = `Error (${response.status}): ${result.output || response.statusText}`;
                }

            } catch (error) {
                console.error('Fetch Error:', error);
                outputDiv.textContent = `Network or client-side error: ${error.message}`;
            } finally {
                sendButton.disabled = false;
            }
        });
    } // end if(sendButton)
});