
// --- Cookie Helper Functions ---
function setCookie(name, value, days) {
    let expires = "";
    if (days) {
        const date = new Date();
        date.setTime(date.getTime() + (days * 24 * 60 * 60 * 1000));
        expires = "; expires=" + date.toUTCString();
    }
    // Add SameSite=Lax for better security, adjust path if needed
    document.cookie = name + "=" + (value || "") + expires + "; path=/; SameSite=Lax";
    console.log(`Cookie set: ${name}=${value}`);
}

function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) == 0) {
            const value = c.substring(nameEQ.length, c.length);
            console.log(`Cookie get: ${name}=${value}`);
            return value;
        }
    }
    console.log(`Cookie get: ${name}=null`);
    return null;
}

function eraseCookie(name) {
    document.cookie = name + '=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT; SameSite=Lax';
    console.log(`Cookie erased: ${name}`);
}

// --- DOM Ready ---
document.addEventListener('DOMContentLoaded', () => {
    // --- Global Elements ---
    const commandTypeSelect = document.getElementById('command-type');
    const optionsArea = document.getElementById('command-options-area');
    const generatedCommandTextarea = document.getElementById('generated-command');
    const sendButton = document.getElementById('send-command');
    const outputDiv = document.getElementById('output');
    const gameSelector = document.getElementById('game-selector'); // Dropdown for game selection
    const targetGameInput = document.getElementById('target-game-input'); // Hidden input to store current target
    const targetPasswordInput = document.getElementById('target-password'); // Password input
    const targetVariantInput = document.getElementById('target-variant'); // Variant input (added)
    const gameStateSidebar = document.getElementById('game-state-sidebar'); // The div containing game state
    const refreshStateButton = document.getElementById('refresh-game-state');
    const clearCredentialsButton = document.getElementById('clear-credentials');

    let currentGameData = null; // Store the detailed state of the selected game
    let allGamesList = []; // Store the list of all games for the selector

    // --- Initial Setup ---
    function initializeDashboard() {
        // Fetch all games for the selector
        fetch('/api/games')
            .then(response => response.json())
            .then(data => {
                if (data.success && data.games) {
                    allGamesList = data.games;
                    populateGameSelector(allGamesList);
                    // Set initial game from cookie after populating selector
                    const initialGame = getCookie('targetGame');
                    if (initialGame && gameSelector) {
                        gameSelector.value = initialGame;
                        targetGameInput.value = initialGame;
                        console.log("Initial game from cookie:", initialGame);
                        fetchAndDisplayGameState(initialGame); // Fetch state for the cookie game
                    } else if (gameSelector && gameSelector.options.length > 1) {
                         // If no cookie, but games exist, select the first one? Or leave blank?
                         // Let's leave it blank initially. User selects.
                         updateGameStateSidebar(null); // Show empty state
                         updateCommandGenerator(null); // Show default recommendations
                         console.log("No initial game cookie or no games found.");
                    } else {
                         updateGameStateSidebar(null);
                         updateCommandGenerator(null);
                         console.log("No games available.");
                    }
                    // Load credentials for the initial game
                    loadCredentialsForGame(initialGame);
                } else {
                    console.error("Failed to fetch game list:", data.message);
                     updateGameStateSidebar(null); // Show empty state on error
                     updateCommandGenerator(null);
                }
            })
            .catch(error => {
                console.error('Error fetching game list:', error);
                updateGameStateSidebar(null);
                updateCommandGenerator(null);
            });
    }

    function populateGameSelector(games) {
        if (!gameSelector) return;
        gameSelector.innerHTML = '<option value="">-- Select Target Game --</option>'; // Default option
        games.sort((a, b) => a.name.localeCompare(b.name)).forEach(game => {
            const option = document.createElement('option');
            option.value = game.name;
            option.textContent = `${game.name} (${game.status || 'Unknown'})`;
            gameSelector.appendChild(option);
        });
    }

    // --- Game State Handling ---
    function fetchAndDisplayGameState(gameName) {
        if (!gameName) {
            updateGameStateSidebar(null);
            updateCommandGenerator(null); // Update recommendations for "no game" context
            targetGameInput.value = '';
            loadCredentialsForGame(null); // Clear credentials fields
            return;
        }

        console.log("Fetching state for:", gameName);
        gameStateSidebar.innerHTML = '<p class="text-gray-500 italic">Loading game state...</p>'; // Loading indicator

        fetch(`/api/game/${gameName}`)
            .then(response => response.json())
            .then(data => {
                if (data.success) {
                    currentGameData = data.gameState; // Store full state
                    updateGameStateSidebar(currentGameData);
                    updateCommandGenerator(data.recommendedCommands); // Update commands based on fetched state
                    targetGameInput.value = gameName; // Update hidden input
                    setCookie('targetGame', gameName, 30); // Update cookie
                    loadCredentialsForGame(gameName); // Load credentials for this game
                } else {
                    console.error(`Failed to fetch game state for ${gameName}:`, data.message);
                    gameStateSidebar.innerHTML = `<p class="text-red-600">Error loading state for ${gameName}: ${data.message}</p>`;
                    currentGameData = null;
                    updateCommandGenerator(null); // Reset recommendations
                    loadCredentialsForGame(gameName); // Still try to load credentials
                }
            })
            .catch(error => {
                console.error(`Error fetching game state for ${gameName}:`, error);
                gameStateSidebar.innerHTML = `<p class="text-red-600">Network error loading state for ${gameName}.</p>`;
                currentGameData = null;
                updateCommandGenerator(null);
                loadCredentialsForGame(gameName);
            });
    }

    function updateGameStateSidebar(gameState) {
        if (!gameStateSidebar) return;

        if (!gameState) {
            gameStateSidebar.innerHTML = '<p class="text-gray-500 italic">Select a game to view its state.</p>';
            return;
        }

        // Format deadline nicely
        let deadlineStr = 'N/A';
        if (gameState.nextDeadline) {
            try {
                // Attempt to parse common judge formats (e.g., Mon Nov 17 2003 23:31:03 -0600)
                const date = new Date(gameState.nextDeadline);
                 // Check if it's a valid date object *and* not the epoch date (which Date() returns for invalid strings)
                if (!isNaN(date) && date.getTime() !== 0) {
                    deadlineStr = date.toLocaleString();
                } else {
                    deadlineStr = gameState.nextDeadline; // Show raw string if parsing failed
                }
            } catch (e) {
                deadlineStr = gameState.nextDeadline; // Show raw string on error
            }
        }

        const playersHtml = (gameState.players && gameState.players.length > 0)
            ? `<ul class="space-y-1 pl-2">
                ${gameState.players.sort((a, b) => (a.power || '').localeCompare(b.power || '')).map(p => `
                    <li class="${p.email === document.body.dataset.userEmail ? 'font-semibold text-blue-700' : ''}">
                        ${p.power || '???'}:
                        ${p.status && p.status !== 'Playing' && p.status !== 'Waiting'
                            ? `<span class="${['CD', 'Resigned', 'Abandoned', 'Eliminated'].includes(p.status) ? 'text-red-600' : 'text-gray-600'}">(${p.status})</span>`
                            : (p.status === 'Waiting' ? '<span class="text-orange-600">(Waiting)</span>' : '')
                        }
                        ${p.email && (!gameState.settings || !gameState.settings.gunboat) ? `<span class="text-gray-500 text-xs ml-1">(${p.email})</span>` : ''}
                    </li>
                `).join('')}
            </ul>`
            : 'N/A';

        const settingsHtml = (gameState.settings && Object.keys(gameState.settings).length > 0)
            ? `<ul class="space-y-1 pl-2 text-xs">
                ${Object.entries(gameState.settings).map(([key, value]) => `<li>${key.charAt(0).toUpperCase() + key.slice(1)}: ${typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value}</li>`).join('')}
            </ul>`
            : 'N/A';

        const lastUpdatedStr = gameState.lastUpdated ? new Date(gameState.lastUpdated * 1000).toLocaleString() : 'N/A';

        gameStateSidebar.innerHTML = `
            <h2 class="text-xl font-semibold text-primary border-b border-gray-200 pb-3 mb-4">Game State: ${gameState.name}</h2>
            <div class="space-y-2 text-sm">
                <div><strong class="text-primary w-24 inline-block">Status:</strong> ${gameState.status || 'Unknown'}</div>
                <div><strong class="text-primary w-24 inline-block">Phase:</strong> ${gameState.currentPhase || 'Unknown'}</div>
                <div><strong class="text-primary w-24 inline-block">Deadline:</strong> ${deadlineStr}</div>
                <div><strong class="text-primary w-24 inline-block">Variant:</strong> ${gameState.variant || 'Standard'} ${gameState.options && gameState.options.length > 0 ? `(${gameState.options.join(', ')})` : ''}</div>
                <div><strong class="text-primary w-24 inline-block">Masters:</strong> ${gameState.masters && gameState.masters.length > 0 ? gameState.masters.join(', ') : 'N/A'}</div>
                <div><strong class="text-primary w-24 inline-block">Observers:</strong> ${gameState.observers ? gameState.observers.length : 'N/A'}</div>

                ${gameState.players && gameState.players.length > 0 ? `
                    <div class="pt-2 mt-2 border-t border-gray-200">
                        <strong class="text-primary block mb-1">Players (${gameState.players.length}):</strong>
                        ${playersHtml}
                    </div>
                ` : '<div><strong class="text-primary w-24 inline-block">Players:</strong> N/A</div>'}

                 ${gameState.settings && Object.keys(gameState.settings).length > 0 ? `
                    <div class="pt-2 mt-2 border-t border-gray-200">
                        <strong class="text-primary block mb-1">Settings:</strong>
                        ${settingsHtml}
                    </div>
                 ` : ''}
            </div>
            <p class="text-xs text-gray-500 mt-4">(State last updated: ${lastUpdatedStr})</p>
            <a href="https://www.floc.net/observer.py?partie=${gameState.name}" target="_blank" rel="noopener noreferrer" class="text-sm text-primary hover:text-primary/80 mt-4 inline-block underline">View on Floc.net Observer</a>
        `;
    }

    // --- Credential Handling (Password + Variant) ---
    function saveCredentialsForGame() {
        const gameName = targetGameInput.value;
        const password = targetPasswordInput.value;
        const variant = targetVariantInput.value; // Get variant value

        if (gameName) {
            if (password) {
                // WARNING: Storing password in cookie is insecure.
                setCookie(`targetPassword_${gameName}`, password, 30);
            } else {
                eraseCookie(`targetPassword_${gameName}`); // Erase if empty
            }

            if (variant) {
                setCookie(`targetVariant_${gameName}`, variant, 30); // Save variant
            } else {
                eraseCookie(`targetVariant_${gameName}`); // Erase if empty
            }
        }
    }

    function loadCredentialsForGame(gameName) {
        if (gameName) {
            const savedPassword = getCookie(`targetPassword_${gameName}`);
            targetPasswordInput.value = savedPassword || '';
            const savedVariant = getCookie(`targetVariant_${gameName}`); // Load variant
            targetVariantInput.value = savedVariant || ''; // Set variant input
        } else {
            targetPasswordInput.value = ''; // Clear if no game selected
            targetVariantInput.value = ''; // Clear variant input too
        }
    }

    function clearAllCredentials() {
         if (confirm('Are you sure you want to clear the stored password and variant for the current game and remove the target game selection?')) {
             const gameName = targetGameInput.value;
             if (gameName) {
                 eraseCookie(`targetPassword_${gameName}`);
                 eraseCookie(`targetVariant_${gameName}`); // Erase variant cookie
             }
             eraseCookie('targetGame');
             targetGameInput.value = '';
             targetPasswordInput.value = '';
             targetVariantInput.value = ''; // Clear variant input
             if (gameSelector) gameSelector.value = '';
             fetchAndDisplayGameState(null); // Reset UI
             alert('Credentials and target game cleared.');
         }
    }

    // --- Command Generator Logic ---
    function updateCommandGenerator(recommendedCommands) {
        if (!commandTypeSelect) return;

        const currentSelection = commandTypeSelect.value; // Preserve selection if possible
        commandTypeSelect.innerHTML = '<option value="">-- Select Action --</option>'; // Clear existing options

        // Default structure if no recommendations fetched
        const defaultCommands = {
             recommended: ['SIGN ON ?', 'SIGN ON ?game', 'SIGN ON power', 'OBSERVE', 'LIST'],
             gameInfo: ['WHOGAME', 'HISTORY', 'SUMMARY', 'CREATE ?'],
             playerActions: ['SET PASSWORD', 'SET ADDRESS'],
             settings: [],
             master: [],
             general: ['GET', 'WHOIS', 'HELP', 'VERSION', 'MANUAL']
        };
        const commands = recommendedCommands || defaultCommands;

        const addOptGroup = (label, commandList) => {
            if (commandList && commandList.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = label;
                optgroup.className = 'font-semibold bg-gray-100'; // Style optgroup
                commandList.forEach(cmd => {
                    // Exclude REGISTER from selector as it has its own page
                    if (cmd !== 'REGISTER') {
                        const option = document.createElement('option');
                        option.value = cmd;
                        option.textContent = cmd;
                        optgroup.appendChild(option);
                    }
                });
                commandTypeSelect.appendChild(optgroup);
            }
        };

        addOptGroup('Recommended', commands.recommended);
        addOptGroup('Player Actions', commands.playerActions);
        addOptGroup('Settings & Future Orders', commands.settings);
        addOptGroup('Game Info', commands.gameInfo);
        addOptGroup('Master Only', commands.master);
        addOptGroup('General', commands.general);

        // Try to restore previous selection
        if (currentSelection && commandTypeSelect.querySelector(`option[value="${currentSelection}"]`)) {
             commandTypeSelect.value = currentSelection;
        } else {
             commandTypeSelect.value = ""; // Reset if previous selection is gone
        }

        // Trigger change event manually if a value is selected, to populate options
        if (commandTypeSelect.value) {
            commandTypeSelect.dispatchEvent(new Event('change'));
        } else {
             // Clear options if no command is selected
             optionsArea.innerHTML = '<p class="text-sm text-gray-500 italic">Select an action above to see options.</p>';
             generatedCommandTextarea.value = '';
             generatedCommandTextarea.placeholder = "Select action or type command manually. Do NOT include SIGN OFF.";
        }
    }

    function generateCommandOptions(selectedCommand) {
        optionsArea.innerHTML = ''; // Clear previous options
        generatedCommandTextarea.value = ''; // Clear textarea
        generatedCommandTextarea.placeholder = "Configure options above or type command here directly. Do NOT include SIGN OFF."; // Reset placeholder

        const targetGame = targetGameInput.value || '<game>'; // Use selected game or placeholder

        // Add cases based on commands available in njudgedocs.txt
        switch (selectedCommand) {
            // --- Game Joining/Creation ---
            case 'CREATE ?':
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div> <label for="create-game-name" class="block text-sm font-medium text-gray-700 mb-1">New Game Name (max 8 chars):</label> <input type="text" id="create-game-name" required maxlength="8" placeholder="e.g., newgame" class="input"> </div>
                        <div> <label for="create-password" class="block text-sm font-medium text-gray-700 mb-1">Password:</label> <input type="password" id="create-password" required class="input"> </div>
                        <div> <label for="create-variant" class="block text-sm font-medium text-gray-700 mb-1">Variant/Options (optional):</label> <input type="text" id="create-variant" placeholder="e.g., Chaos Gunboat" class="input"> </div>
                        <div class="flex items-center space-x-2"> <input type="checkbox" id="create-become-master" class="rounded border-gray-300 text-primary focus:ring-primary"> <label for="create-become-master" class="text-sm font-medium text-gray-700">Become Master?</label> </div>
                    </div>`;
                 break;
            case 'OBSERVE': case 'WATCH':
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div> <label for="observe-game" class="block text-sm font-medium text-gray-700 mb-1">Game Name:</label> <input type="text" id="observe-game" required value="${targetGame !== '<game>' ? targetGame : ''}" placeholder="e.g., watchgame" class="input"> </div>
                        <div> <label for="observe-password" class="block text-sm font-medium text-gray-700 mb-1">Password:</label> <input type="password" id="observe-password" required class="input"> </div>
                    </div>`;
                 break;
             case 'SIGN ON ?': // Sign on to next available
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div> <label for="signon-next-password" class="block text-sm font-medium text-gray-700 mb-1">Password:</label> <input type="password" id="signon-next-password" required class="input"> </div>
                    </div>`;
                break;
             case 'SIGN ON ?game': // Sign on to specific forming game
                optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div> <label for="signon-q-game" class="block text-sm font-medium text-gray-700 mb-1">Game Name:</label> <input type="text" id="signon-q-game" required value="${targetGame !== '<game>' ? targetGame : ''}" placeholder="e.g., forminggame" class="input"> </div>
                        <div> <label for="signon-q-password" class="block text-sm font-medium text-gray-700 mb-1">Password:</label> <input type="password" id="signon-q-password" required class="input"> </div>
                        <div> <label for="signon-q-variant" class="block text-sm font-medium text-gray-700 mb-1">Variant/Options (if required):</label> <input type="text" id="signon-q-variant" placeholder="e.g., Chaos Gunboat" class="input"> </div>
                    </div>`;
                break;
            case 'SIGN ON power': // Sign on to specific power in existing game
                optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div>
                            <label for="signon-power" class="block text-sm font-medium text-gray-700 mb-1">Power Initial:</label>
                            <input type="text" id="signon-power" size="1" maxlength="1" required placeholder="e.g., F" class="input w-10 inline-block mr-2">
                            <label for="signon-game" class="inline-block text-sm font-medium text-gray-700 mb-1">Game Name:</label>
                            <input type="text" id="signon-game" required value="${targetGame !== '<game>' ? targetGame : ''}" placeholder="e.g., mygame" class="input inline-block w-auto flex-grow">
                        </div>
                        <div> <label for="signon-password" class="block text-sm font-medium text-gray-700 mb-1">Password:</label> <input type="password" id="signon-password" required class="input"> </div>
                    </div>`;
                break;

            // --- Game Info ---
            case 'LIST': case 'HISTORY': case 'SUMMARY': case 'WHOGAME':
                 const cmdLowerList = selectedCommand.toLowerCase();
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div>
                            <label for="${cmdLowerList}-game-name" class="block text-sm font-medium text-gray-700 mb-1">Game Name (${selectedCommand === 'LIST' ? 'optional' : 'required'}, defaults to target):</label>
                            <input type="text" id="${cmdLowerList}-game-name" ${selectedCommand !== 'LIST' ? 'required' : ''} value="${targetGame !== '<game>' ? targetGame : ''}" placeholder="e.g., mygame" class="input">
                        </div>
                        ${selectedCommand === 'LIST' ? `
                            <div class="flex items-center space-x-2"> <input type="checkbox" id="list-full" class="rounded border-gray-300 text-primary focus:ring-primary"> <label for="list-full" class="text-sm font-medium text-gray-700">Full List (if no game name)?</label> </div>
                            <p class="text-sm text-gray-500">(Note: LIST without game name shows all games on server)</p>
                        ` : ''}
                        ${selectedCommand === 'HISTORY' ? `
                            <div> <label for="hist-from" class="block text-sm font-medium text-gray-700 mb-1">From Date (optional):</label> <input type="text" id="hist-from" placeholder="e.g., Jan 1 2023 or S1901M" class="input"> </div>
                            <div> <label for="hist-to" class="block text-sm font-medium text-gray-700 mb-1">To Date (optional):</label> <input type="text" id="hist-to" placeholder="e.g., Dec 31 2023 or F1905B" class="input"> </div>
                            <div> <label for="hist-lines" class="block text-sm font-medium text-gray-700 mb-1">Max Lines (optional):</label> <input type="number" id="hist-lines" placeholder="e.g., 5000" class="input"> </div>
                            <hr class="my-2"> <p class="text-sm text-gray-500">OR Exclude Range:</p>
                            <div> <label for="hist-exclstart" class="block text-sm font-medium text-gray-700 mb-1">EXCLSTART turnId:</label> <input type="text" id="hist-exclstart" placeholder="e.g., S1903M" class="input"> </div>
                            <div> <label for="hist-exclend" class="block text-sm font-medium text-gray-700 mb-1">EXCLEND turnId:</label> <input type="text" id="hist-exclend" placeholder="e.g., F1905B" class="input"> </div>
                            <div class="flex items-center space-x-2"> <input type="checkbox" id="hist-broad" class="rounded border-gray-300 text-primary focus:ring-primary"> <label for="hist-broad" class="text-sm font-medium text-gray-700">Include Broadcasts (with EXCL)?</label> </div>
                        ` : ''}
                         ${selectedCommand === 'WHOGAME' ? `
                            <div class="flex items-center space-x-2"> <input type="checkbox" id="whogame-full" class="rounded border-gray-300 text-primary focus:ring-primary"> <label for="whogame-full" class="text-sm font-medium text-gray-700">Include Observers (FULL)?</label> </div>
                         ` : ''}
                    </div>`;
                break;

            // --- In-Game Actions ---
            case 'ORDERS':
                 optionsArea.innerHTML = `
                    <div class="space-y-2">
                        <p class="text-gray-600">Enter orders directly into the text area below.</p>
                        <p class="text-sm text-gray-500">Example: <code class="bg-gray-100 px-1 py-0.5 rounded">A Par H</code>, <code class="bg-gray-100 px-1 py-0.5 rounded">F Lon - Nth</code>, <code class="bg-gray-100 px-1 py-0.5 rounded">A Mun S A Ber - Sil</code></p>
                        <p class="text-sm text-gray-500">Separate multiple orders with newlines or commas.</p>
                        <p class="text-sm text-gray-500">Use specific syntax for Retreats/Builds/Removes if in that phase.</p>
                        <p class="text-sm text-red-600 font-medium">Remember to specify convoy routes: <code class="bg-gray-100 px-1 py-0.5 rounded">A Lon-Nth-Nwy</code> NOT <code class="bg-gray-100 px-1 py-0.5 rounded">A Lon-Nwy</code>.</p>
                    </div>`;
                 generatedCommandTextarea.placeholder = "Enter orders here...\ne.g., A PAR H\nF BRE - MAO";
                 break;
            case 'PRESS': case 'BROADCAST': case 'POSTAL PRESS': // Added POSTAL PRESS
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div> <label for="press-options" class="block text-sm font-medium text-gray-700 mb-1">Press Options (e.g., TO FRG, GREY, FAKE TO A):</label> <input type="text" id="press-options" placeholder="e.g., TO AET, GREY TO R" class="input"> </div>
                        <div> <label for="press-body" class="block text-sm font-medium text-gray-700 mb-1">Press Message Body:</label> <textarea id="press-body" rows="4" required class="input font-mono text-sm"></textarea> </div>
                        <p class="text-sm text-gray-500">Command will be: ${selectedCommand} [options]\\n[body]\\nENDPRESS</p>
                        ${selectedCommand === 'POSTAL PRESS' ? '<p class="text-sm text-orange-600">Note: Postal Press is broadcast-only and delivered after the turn processes.</p>' : ''}
                    </div>`;
                 generatedCommandTextarea.placeholder = "Enter message body here...";
                 break;
            case 'DIARY':
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div> <label for="diary-action" class="block text-sm font-medium text-gray-700 mb-1">Action:</label> <select id="diary-action" class="input"> <option value="RECORD" selected>RECORD Entry</option> <option value="LIST">LIST Entries</option> <option value="READ">READ Entry</option> <option value="DELETE">DELETE Entry</option> </select> </div>
                        <div id="diary-entry-num-div" class="hidden"> <label for="diary-entry-num" class="block text-sm font-medium text-gray-700 mb-1">Entry Number (for READ/DELETE):</label> <input type="number" id="diary-entry-num" class="input"> </div>
                        <div id="diary-body-div"> <label for="diary-body" class="block text-sm font-medium text-gray-700 mb-1">Diary Entry Body (for RECORD):</label> <textarea id="diary-body" rows="5" class="input font-mono text-sm"></textarea> </div>
                        <p class="text-sm text-gray-500">For RECORD, the command will be: DIARY RECORD\\n[body]\\nENDPRESS</p>
                    </div>`;
                 // Need timeout to ensure elements exist before attaching listener
                 setTimeout(() => {
                     const actionSelect = document.getElementById('diary-action');
                     const numDiv = document.getElementById('diary-entry-num-div');
                     const bodyDiv = document.getElementById('diary-body-div');
                     if (!actionSelect || !numDiv || !bodyDiv) return;
                     const updateDiaryFields = () => {
                         const action = actionSelect.value;
                         numDiv.classList.toggle('hidden', action !== 'READ' && action !== 'DELETE');
                         bodyDiv.classList.toggle('hidden', action !== 'RECORD');
                         updateGeneratedCommandText(); // Update command text when visibility changes
                     };
                     actionSelect.addEventListener('change', updateDiaryFields);
                     updateDiaryFields(); // Initial setup
                 }, 0);
                 generatedCommandTextarea.placeholder = "Enter diary entry body here for RECORD...";
                 break;

            // --- Settings & Future Orders ---
             case 'SET WAIT': case 'SET NOWAIT': case 'SET NOABSENCE': case 'SET NODRAW': case 'SET NOCONCEDE': case 'CLEAR': case 'RESIGN': case 'WITHDRAW':
                 optionsArea.innerHTML = `<div class="space-y-4"><p class="text-gray-600">No parameters needed for ${selectedCommand}.</p></div>`; break;
             case 'SET ABSENCE':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <div> <label for="absence-start" class="block text-sm font-medium text-gray-700 mb-1">Start Date:</label> <input type="text" id="absence-start" required placeholder="e.g., Jan 1 2024 or Mon" class="input"> </div>
                         <div> <label for="absence-end" class="block text-sm font-medium text-gray-700 mb-1">End Date (optional, defaults to 24h):</label> <input type="text" id="absence-end" placeholder="e.g., Jan 15 2024 or Fri" class="input"> </div>
                     </div>`; break;
             case 'SET DRAW':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <div> <label for="draw-powers" class="block text-sm font-medium text-gray-700 mb-1">Powers to include (optional, for NoDIAS games):</label> <input type="text" id="draw-powers" placeholder="e.g., AEFG (leave blank for DIAS)" class="input"> </div>
                     </div>`; break;
             case 'SET CONCEDE':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <div> <label for="concede-power" class="block text-sm font-medium text-gray-700 mb-1">Power Initial to Concede To:</label> <input type="text" id="concede-power" size="1" maxlength="1" required placeholder="e.g., F" class="input w-10"> </div>
                     </div>`; break;
             case 'SET PASSWORD': // User account setting
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <div> <label for="new-password" class="block text-sm font-medium text-gray-700 mb-1">New Password:</label> <input type="password" id="new-password" required class="input"> </div>
                         <p class="text-sm text-orange-600">Note: This changes your password for ALL games on this judge.</p>
                     </div>`; break;
             case 'SET ADDRESS': // User account setting
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <div> <label for="new-address" class="block text-sm font-medium text-gray-700 mb-1">New Email Address (optional, uses sending address if blank):</label> <input type="email" id="new-address" placeholder="new@example.com" class="input"> </div>
                         <p class="text-sm text-gray-500">Leave blank to use the address you logged in with.</p>
                         <p class="text-sm text-orange-600">Note: This changes your reply-to address for ALL games on this judge.</p>
                     </div>`; break;
             case 'SET PREFERENCE': // Forming game action
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <div> <label for="preference-list" class="block text-sm font-medium text-gray-700 mb-1">Preference List:</label> <input type="text" id="preference-list" required placeholder="e.g., E[FGR][TAI] or *" class="input"> </div>
                         <p class="text-sm text-gray-500">Only effective in forming games before powers are assigned.</p>
                     </div>`; break;
             case 'PHASE':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <div> <label for="phase-season" class="block text-sm font-medium text-gray-700 mb-1">Season:</label> <select id="phase-season" required class="input"> <option value="Spring">Spring</option> <option value="Summer">Summer (Variant)</option> <option value="Fall">Fall</option> <option value="Winter">Winter</option> </select> </div>
                         <div> <label for="phase-year" class="block text-sm font-medium text-gray-700 mb-1">Year:</label> <input type="number" id="phase-year" required placeholder="e.g., 1905" class="input"> </div>
                         <div> <label for="phase-type" class="block text-sm font-medium text-gray-700 mb-1">Phase Type:</label> <select id="phase-type" required class="input"> <option value="Movement">Movement</option> <option value="Retreat">Retreat</option> <option value="Adjustment">Adjustment/Build</option> </select> </div>
                         <p class="text-sm text-gray-500">Enter orders for this future phase below the generated command.</p>
                     </div>`;
                 generatedCommandTextarea.placeholder = "Enter future orders here after PHASE command..."; break;
             case 'IF':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <div> <label for="if-condition" class="block text-sm font-medium text-gray-700 mb-1">Condition:</label> <input type="text" id="if-condition" required placeholder="e.g., NOT French Army Ruhr AND (Russian Prussia OR Russian Silesia)" class="input"> </div>
                         <p class="text-sm text-gray-500">Enter orders for the IF block below the generated command, optionally followed by ELSE/ENDIF.</p>
                     </div>`;
                 generatedCommandTextarea.placeholder = "IF condition\n  Order1\nELSE\n  Order2\nENDIF"; break;

            // --- General / Info ---
             case 'GET':
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div> <label for="get-filename" class="block text-sm font-medium text-gray-700 mb-1">Filename:</label> <input type="text" id="get-filename" required placeholder="e.g., info, rules, map, guide, form, flist" class="input"> </div>
                    </div>`;
                 break;
             case 'WHOIS':
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <div> <label for="whois-email" class="block text-sm font-medium text-gray-700 mb-1">Email Address (or start of):</label> <input type="text" id="whois-email" required placeholder="e.g., user@ or user@domain.com" class="input"> </div>
                    </div>`;
                 break;
             case 'HELP': case 'VERSION':
                  optionsArea.innerHTML = `<div class="space-y-4"><p class="text-gray-600">No parameters needed for ${selectedCommand}.</p></div>`; break;

            // --- Master Only ---
             case 'SET': // Generic SET for master - Use with caution!
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <p class="text-sm text-red-600">Warning: Master Only. Use specific SET commands if available.</p>
                         <div> <label for="set-option" class="block text-sm font-medium text-gray-700 mb-1">Option to Set:</label> <input type="text" id="set-option" required placeholder="e.g., DEADLINE, VARIANT, NMR, PRESS" class="input"> </div>
                         <div> <label for="set-value" class="block text-sm font-medium text-gray-700 mb-1">Value:</label> <input type="text" id="set-value" required placeholder="e.g., Mon Jan 1 2024 23:00, Standard Gunboat, ON, GREY" class="input"> </div>
                     </div>`;
                 break;
             case 'PROCESS':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <p class="text-sm text-red-600">Warning: Master Only. Processes current turn immediately.</p>
                         <div> <label for="process-phase" class="block text-sm font-medium text-gray-700 mb-1">Phase to Process (optional but recommended):</label> <input type="text" id="process-phase" placeholder="e.g., F1905R or Fall 1905 Retreat" class="input"> </div>
                     </div>`; break;
             case 'ROLLBACK':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <p class="text-sm text-red-600">Warning: Master Only. Reverts game state.</p>
                         <div> <label for="rollback-turn" class="block text-sm font-medium text-gray-700 mb-1">Turn Number (optional, defaults to last turn):</label> <input type="number" id="rollback-turn" placeholder="e.g., 001" class="input"> </div>
                     </div>`; break;
             case 'EJECT':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <p class="text-sm text-red-600">Warning: Master Only. Removes player/observer.</p>
                         <div> <label for="eject-target" class="block text-sm font-medium text-gray-700 mb-1">Power Initial or Observer Email:</label> <input type="text" id="eject-target" required placeholder="e.g., F or observer@example.com" class="input"> </div>
                     </div>`; break;
             case 'BECOME':
                 optionsArea.innerHTML = `
                     <div class="space-y-4">
                         <p class="text-sm text-red-600">Warning: Master Only. Executes commands as another power.</p>
                         <div> <label for="become-power" class="block text-sm font-medium text-gray-700 mb-1">Power Initial or Name:</label> <input type="text" id="become-power" required placeholder="e.g., F or France" class="input"> </div>
                         <p class="text-sm text-gray-500">Enter commands to be executed as this power below the generated command.</p>
                     </div>`;
                 generatedCommandTextarea.placeholder = "Enter commands to run as the specified power..."; break;
             case 'PAUSE': case 'RESUME': case 'TERMINATE': case 'FORCE BEGIN': case 'UNSTART': case 'PROMOTE': // Added PROMOTE
                  const masterOnlyText = ['PAUSE', 'RESUME', 'TERMINATE', 'FORCE BEGIN', 'UNSTART', 'PROMOTE'].includes(selectedCommand);
                  optionsArea.innerHTML = `<div class="space-y-4"> ${masterOnlyText ? '<p class="text-sm text-red-600">Warning: Master Only command.</p>' : ''} <p class="text-gray-600">Check docs for parameters for ${selectedCommand}. Enter below if needed.</p> </div>`;
                  if (selectedCommand === 'PROMOTE') {
                       optionsArea.innerHTML += `<div> <label for="promote-observer" class="block text-sm font-medium text-gray-700 mb-1">Observer Email to Promote:</label> <input type="email" id="promote-observer" required placeholder="observer@example.com" class="input"> </div>`;
                  }
                  break;
             // Add specific Master SET commands here if desired (e.g., SET DEADLINE, SET VARIANT)
             // ...

            // --- Manual / Default ---
             case 'MANUAL':
                 optionsArea.innerHTML = `
                    <div class="space-y-4">
                        <p class="text-gray-600">Enter the full command manually in the text area below. Do NOT include SIGN OFF.</p>
                        <p class="text-sm text-gray-500">The server will prepend SIGN ON automatically if needed for the target game.</p>
                    </div>`;
                 generatedCommandTextarea.placeholder = "Type full command here (e.g., WHOIS someone@example.com)";
                 break;
            default:
                optionsArea.innerHTML = `<div class="space-y-4"><p class="text-gray-600">Parameters for <strong>${selectedCommand}</strong> (if any) should be entered directly in the text area below.</p> Check HELP ${selectedCommand} if unsure.</div>`;
                generatedCommandTextarea.value = selectedCommand + ' '; // Start with the command verb
                break;
        }

        // Attach listeners to new inputs/selects/textareas AFTER they are in the DOM
        setTimeout(() => {
            optionsArea.querySelectorAll('input, select, textarea').forEach(el => {
                // Use 'input' for text fields, 'change' for select/checkbox
                const eventType = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
                el.removeEventListener(eventType, updateGeneratedCommandText); // Remove old listener if any
                el.addEventListener(eventType, updateGeneratedCommandText);
            });
            updateGeneratedCommandText(); // Update text area based on initial options
        }, 0); // Timeout ensures DOM update is processed
    }

    function updateGeneratedCommandText() {
        if (!commandTypeSelect || !generatedCommandTextarea) return;

        const selectedCommand = commandTypeSelect.value;
        if (!selectedCommand) {
            // Don't clear if user might be typing manually
            // generatedCommandTextarea.value = '';
            return;
        }

        let commandString = selectedCommand;
        let commandBody = '';
        // Commands where the text area IS the body or follows the generated line
        const commandsWithBodyInput = ['ORDERS', 'MANUAL', 'PRESS', 'BROADCAST', 'POSTAL PRESS', 'DIARY', 'PHASE', 'IF', 'BECOME', 'CREATE ?'];
        const currentText = generatedCommandTextarea.value;
        const lines = currentText.split('\n');

        // Preserve existing body if command type matches and body exists
        if (commandsWithBodyInput.includes(selectedCommand)) {
             if (selectedCommand === 'ORDERS' || selectedCommand === 'MANUAL') {
                 // For these, the *entire* textarea is the command
                 commandString = currentText;
                 commandBody = ''; // No separate body needed
             } else if (lines.length > 0 && lines[0].trim().startsWith(selectedCommand)) {
                 // If the first line starts with the command, assume subsequent lines are body
                 commandBody = lines.slice(1).join('\n');
                 commandString = lines[0]; // Keep the generated first line
                 // Special handling for multi-line commands like PRESS/DIARY/etc.
                 if (['PRESS', 'BROADCAST', 'POSTAL PRESS', 'DIARY'].includes(selectedCommand)) {
                      // Reconstruct the command string based on options, keep the body
                      commandString = buildCommandStringFromOptions(selectedCommand); // Get the first line
                      // Find ENDPRESS/ENDBROADCAST and take text before it
                      const endPressIndex = lines.findIndex(line => line.trim() === 'ENDPRESS' || line.trim() === 'ENDBROADCAST');
                      if (endPressIndex > 0) { // Make sure ENDPRESS is not the first line
                           commandBody = lines.slice(1, endPressIndex).join('\n');
                      } else if (lines.length > 1) {
                           // If no ENDPRESS, assume all lines after first are body (user might add ENDPRESS manually)
                           commandBody = lines.slice(1).join('\n');
                      } else {
                           commandBody = ''; // No body yet
                      }
                 } else if (['PHASE', 'IF', 'BECOME'].includes(selectedCommand)) {
                      commandString = buildCommandStringFromOptions(selectedCommand);
                      commandBody = lines.slice(1).join('\n');
                 } else if (selectedCommand === 'CREATE ?') {
                      commandString = buildCommandStringFromOptions(selectedCommand);
                      commandBody = lines.slice(1).join('\n'); // Preserve BECOME MASTER etc.
                 }
             } else {
                  // Command selected, but text area doesn't start with it - generate fresh
                  commandString = buildCommandStringFromOptions(selectedCommand);
                  commandBody = ''; // Reset body
                  if (['PRESS', 'BROADCAST', 'POSTAL PRESS', 'DIARY'].includes(selectedCommand)) {
                       commandBody = '<message body>\nENDPRESS'; // Default body placeholder
                  } else if (['PHASE', 'IF', 'BECOME'].includes(selectedCommand)) {
                       commandBody = '...'; // Placeholder for orders
                  } else if (selectedCommand === 'ORDERS') {
                       commandString = ''; // Start empty for orders
                       commandBody = '';
                  } else if (selectedCommand === 'MANUAL') {
                       commandString = ''; // Start empty for manual
                       commandBody = '';
                  }
             }
        } else {
            // Command does not have a body input area, generate fresh
            commandString = buildCommandStringFromOptions(selectedCommand);
            commandBody = '';
        }


        let finalOutput = commandString;
        // Append body only if it exists and the command expects it
        if (commandBody && commandsWithBodyInput.includes(selectedCommand) && selectedCommand !== 'ORDERS' && selectedCommand !== 'MANUAL') {
             // Ensure newline separation if commandString isn't empty
            if (commandString.length > 0 && !commandString.endsWith('\n')) {
                finalOutput += '\n';
            }
            finalOutput += commandBody;
        } else if (commandBody && (selectedCommand === 'ORDERS' || selectedCommand === 'MANUAL')) {
             // For ORDERS/MANUAL, the body *is* the command string
             finalOutput = commandBody;
        }


        // Only update if the generated text is different from current text,
        // to avoid cursor jumping during manual edits in body section.
        if (generatedCommandTextarea.value !== finalOutput) {
             // Store cursor position
             const cursorPos = generatedCommandTextarea.selectionStart;
             generatedCommandTextarea.value = finalOutput;
             // Restore cursor position if it was within the old text length
             if (cursorPos <= currentText.length) {
                  try { // Adding try-catch for safety
                     generatedCommandTextarea.setSelectionRange(cursorPos, cursorPos);
                  } catch (e) {
                     console.warn("Could not restore cursor position:", e);
                  }
             }
        }
    }

    // Helper to build the command string from options (first line usually)
    function buildCommandStringFromOptions(selectedCommand) {
        let commandString = selectedCommand;
        const qs = (selector) => optionsArea.querySelector(selector);
        const val = (selector) => qs(selector)?.value.trim() || '';
        const checked = (selector) => qs(selector)?.checked || false;
        const rawVal = (selector) => qs(selector)?.value || ''; // Don't trim passwords

        switch (selectedCommand) {
            case 'CREATE ?':
                 const createGame = val('#create-game-name'); const createPass = rawVal('#create-password'); const createVariant = val('#create-variant');
                 commandString = `CREATE ?${createGame || '<name>'} ${createPass || '<password>'}`; if (createVariant) commandString += ` ${createVariant}`;
                 // BECOME MASTER handled in body
                 break;
            case 'OBSERVE': case 'WATCH': const observeGame = val('#observe-game'); const observePass = rawVal('#observe-password'); commandString = `${selectedCommand} ${observeGame || '<game>'} ${observePass || '<password>'}`; break;
            case 'SIGN ON ?': const nextPass = rawVal('#signon-next-password'); commandString = `SIGN ON ? ${nextPass || '<password>'}`; break;
            case 'SIGN ON ?game': const gameQ = val('#signon-q-game'); const passQ = rawVal('#signon-q-password'); const variantQ = val('#signon-q-variant'); commandString = `SIGN ON ?${gameQ || '<game>'} ${passQ || '<password>'}`; if (variantQ) commandString += ` ${variantQ}`; break;
            case 'SIGN ON power': const power = val('#signon-power').toUpperCase(); const gameP = val('#signon-game'); const passP = rawVal('#signon-password'); commandString = `SIGN ON ${power || '<P>'}${gameP || '<game>'} ${passP || '<password>'}`; break;
            case 'LIST': const gameNameList = val('#list-game-name'); const fullList = checked('#list-full'); commandString = 'LIST'; if (gameNameList) { commandString += ` ${gameNameList}`; } else if (fullList) { commandString += ' FULL'; } break;
            case 'HISTORY': case 'SUMMARY': case 'WHOGAME': const cmdLower = selectedCommand.toLowerCase(); const gameNameHist = val(`#${cmdLower}-game-name`); if (gameNameHist) { commandString = `${selectedCommand} ${gameNameHist}`; if (selectedCommand === 'HISTORY') { const fromDate = val('#hist-from'); const toDate = val('#hist-to'); const lines = val('#hist-lines'); const exclStart = val('#hist-exclstart'); const exclEnd = val('#hist-exclend'); const broad = checked('#hist-broad'); if (exclStart) { commandString += ` EXCLSTART ${exclStart}`; if (exclEnd) commandString += ` EXCLEND ${exclEnd}`; if (broad) commandString += ` BROAD`; } else { if (fromDate) commandString += ` FROM ${fromDate}`; if (toDate) commandString += ` TO ${toDate}`; if (lines) commandString += ` LINES ${lines}`; } } else if (selectedCommand === 'WHOGAME') { if (checked('#whogame-full')) commandString += ' FULL'; } } else if (selectedCommand !== 'LIST') { commandString = `${selectedCommand} <game_name_required>`; } else { commandString = 'LIST'; } break;
            case 'PRESS': case 'BROADCAST': case 'POSTAL PRESS': const pressOpts = val('#press-options'); commandString = selectedCommand; if (pressOpts) commandString += ` ${pressOpts}`; break; // Body handled separately
            case 'DIARY': const diaryAction = val('#diary-action'); commandString = `DIARY ${diaryAction}`; if (diaryAction === 'READ' || diaryAction === 'DELETE') { const entryNum = val('#diary-entry-num'); commandString += ` ${entryNum || '<number>'}`; } break; // Body handled separately for RECORD
            case 'GET': const filename = val('#get-filename'); commandString = `GET ${filename || '<filename>'}`; break;
            case 'WHOIS': const whoisEmail = val('#whois-email'); commandString = `WHOIS ${whoisEmail || '<email_or_prefix>'}`; break;
            case 'SET': const setOpt = val('#set-option'); const setVal = rawVal('#set-value'); commandString = `SET ${setOpt || '<option>'} ${setVal || '<value>'}`; break;
            case 'SET ABSENCE': const absStart = val('#absence-start'); const absEnd = val('#absence-end'); commandString = `SET ABSENCE ${absStart || '<start_date>'}`; if (absEnd) commandString += ` TO ${absEnd}`; break;
            case 'SET DRAW': const drawPowers = val('#draw-powers'); commandString = `SET DRAW`; if (drawPowers) commandString += ` ${drawPowers}`; break;
            case 'SET CONCEDE': const concedePower = val('#concede-power').toUpperCase(); commandString = `SET CONCEDE ${concedePower || '<P>'}`; break;
            case 'SET PASSWORD': const newPass = rawVal('#new-password'); commandString = `SET PASSWORD ${newPass || '<new_password>'}`; break;
            case 'SET ADDRESS': const newAddr = val('#new-address'); commandString = `SET ADDRESS`; if (newAddr) commandString += ` ${newAddr}`; break;
            case 'SET PREFERENCE': const prefList = val('#preference-list'); commandString = `SET PREFERENCE ${prefList || '<list_or_*>'}`; break;
            case 'PHASE': const phSeason = val('#phase-season'); const phYear = val('#phase-year'); const phType = val('#phase-type'); commandString = `PHASE ${phSeason || '<Season>'} ${phYear || '<Year>'} ${phType || '<Phase>'}`; break; // Body handled separately
            case 'IF': const ifCond = val('#if-condition'); commandString = `IF ${ifCond || '<condition>'}`; break; // Body handled separately
            case 'PROCESS': const procPhase = val('#process-phase'); commandString = `PROCESS`; if (procPhase) commandString += ` ${procPhase}`; break;
            case 'ROLLBACK': const rbTurn = val('#rollback-turn'); commandString = `ROLLBACK`; if (rbTurn) commandString += ` ${rbTurn}`; break;
            case 'EJECT': const ejectTarget = val('#eject-target'); commandString = `EJECT ${ejectTarget || '<power_or_email>'}`; break;
            case 'BECOME': const becomePower = val('#become-power'); commandString = `BECOME ${becomePower || '<power>'}`; break; // Body handled separately
            case 'PROMOTE': const promoteObserver = val('#promote-observer'); commandString = `PROMOTE ${promoteObserver || '<observer_email>'}`; break;
            // Simple commands with no options generated here
            case 'SET WAIT': case 'SET NOWAIT': case 'SET NOABSENCE': case 'SET NODRAW': case 'SET NOCONCEDE': case 'CLEAR': case 'RESIGN': case 'WITHDRAW': case 'HELP': case 'VERSION': case 'PAUSE': case 'RESUME': case 'TERMINATE': case 'FORCE BEGIN': case 'UNSTART': commandString = selectedCommand; break;
            // ORDERS and MANUAL are handled specially in updateGeneratedCommandText
            case 'ORDERS': case 'MANUAL': commandString = ''; break; // Start empty
            default: commandString = selectedCommand; break; // Default to just the command verb
        }
        return commandString;
    }

    // --- Event Listeners ---
    if (commandTypeSelect) {
        commandTypeSelect.addEventListener('change', () => {
            generateCommandOptions(commandTypeSelect.value);
        });
        // Initial population if a command is pre-selected (e.g., on page load with state)
        // generateCommandOptions(commandTypeSelect.value); // This is now handled in updateCommandGenerator
    }

    if (gameSelector) {
        gameSelector.addEventListener('change', () => {
            const selectedGame = gameSelector.value;
            fetchAndDisplayGameState(selectedGame);
        });
    }

    if (targetPasswordInput) {
        // Save password on blur or input change
        targetPasswordInput.addEventListener('change', saveCredentialsForGame);
        // Optionally save more frequently:
        // targetPasswordInput.addEventListener('input', savePasswordForGame);
    }

    if(refreshStateButton) {
        refreshStateButton.addEventListener('click', () => {
            const gameName = targetGameInput.value;
            if (gameName) {
                 outputDiv.textContent = `Refreshing state for ${gameName}...`;
                 outputDiv.className = 'bg-blue-50 border border-blue-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-blue-700';
                 // Execute LIST command for the target game
                 sendCommand(`LIST ${gameName}`);
            } else {
                alert('Please select a game to refresh.');
            }
        });
    }

     if (clearCredentialsButton) {
         clearCredentialsButton.addEventListener('click', clearAllCredentials);
     }

    // Send Command Logic (modified to include target game/password)
    async function sendCommand(commandOverride = null) {
        const commandToSend = commandOverride || generatedCommandTextarea.value.trim();
        const targetGame = targetGameInput.value;
        const targetPassword = targetPasswordInput.value;
        const targetVariant = targetVariantInput.value; // Get variant value

        if (!commandToSend) {
            outputDiv.textContent = 'Error: Command cannot be empty.';
            outputDiv.className = 'bg-red-50 border border-red-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-red-700';
            return;
        }

        // Basic check: Warn if context needed but no game/password selected/entered
        const commandVerb = commandToSend.split(/\s+/)[0].toUpperCase();
        const requiresContext = !['REGISTER', 'WHOIS', 'INFO', 'GET', 'VERSION', 'HELP', 'LIST', 'SIGN', 'OBSERVE', 'WATCH', 'CREATE', 'MANUAL', 'SET PASSWORD', 'SET ADDRESS'].includes(commandVerb);
        if (requiresContext && (!targetGame || !targetPassword)) {
             if (!targetGame) {
                 outputDiv.textContent = `Warning: Command "${commandVerb}" likely requires a target game, but none is selected. Sending anyway...`;
             } else { // No password
                 outputDiv.textContent = `Warning: Command "${commandVerb}" likely requires the password for game "${targetGame}", but none is entered. Sending anyway...`;
             }
             outputDiv.className = 'bg-orange-50 border border-orange-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-orange-700';
             // Allow sending anyway, the judge will reject if needed
        } else {
             outputDiv.textContent = 'Sending command...';
             outputDiv.className = 'bg-gray-50 border border-gray-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-gray-700';
        }

        sendButton.disabled = true;
        sendButton.textContent = 'Sending...';
        sendButton.classList.add('opacity-50', 'cursor-not-allowed');

        try {
            const response = await fetch('/execute-dip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    command: commandToSend,
                    targetGame: targetGame, // Send context
                    targetPassword: targetPassword, // Send context
                    targetVariant: targetVariant // Send variant context (added)
                }),
            });

            // Improved error handling for non-JSON responses
            let result;
            const contentType = response.headers.get('content-type');
            if (response.ok && contentType && contentType.includes('application/json')) {
                 result = await response.json();
            } else if (!response.ok) {
                 const errorText = await response.text();
                 throw new Error(`Server error ${response.status}: ${errorText || response.statusText}`);
            } else {
                 // OK response but not JSON? Unexpected.
                 const text = await response.text();
                 throw new Error(`Unexpected server response: ${response.status} - ${text}`);
            }


            outputDiv.textContent = result.output || 'No output received.';

            if (result.success) {
                outputDiv.classList.remove('text-red-700', 'text-orange-700');
                outputDiv.classList.add('text-green-700');
                outputDiv.textContent = `Command Sent Successfully.\n\n${result.output}`;

                // If sign on/observe/create was successful, update UI context
                if (result.isSignOnOrObserveSuccess) {
                    const gameName = result.createdGameName || targetGame; // Use created name if available
                    outputDiv.textContent += `\n\nSign On / Observe / Create Successful for ${gameName}! Updating context...`;
                    if (gameName && gameSelector) {
                         // Check if game is already in selector, add if not (for CREATE)
                         if (!Array.from(gameSelector.options).some(opt => opt.value === gameName)) {
                              const option = document.createElement('option');
                              option.value = gameName;
                              option.textContent = `${gameName} (Forming)`; // Assume forming initially
                              gameSelector.appendChild(option);
                              allGamesList.push({ name: gameName, status: 'Forming' }); // Add to local list
                         }
                         gameSelector.value = gameName; // Select the game
                         fetchAndDisplayGameState(gameName); // Fetch its state
                    }
                }
                // If state was refreshed by the server, update the sidebar
                else if (result.refreshedGameState) {
                     console.log("Received refreshed game state from server.");
                     currentGameData = result.refreshedGameState;
                     updateGameStateSidebar(currentGameData);
                     // Also update recommendations based on new state
                     updateCommandGenerator(getRecommendedCommands(currentGameData, document.body.dataset.userEmail));
                }
                 // If LIST was run manually and succeeded, parse and update
                 else if (commandVerb === 'LIST' && result.output.includes('--- stdout ---')) {
                     const stdout = result.output.substring(result.output.indexOf('--- stdout ---') + 14, result.output.indexOf('--- stderr ---'));
                     const commandParts = commandToSend.trim().split(/\s+/); // Define commandParts from commandToSend
                     const listGameName = commandParts.length > 1 ? commandParts[1] : null;
                     if (listGameName && /^[a-zA-Z0-9]{1,8}$/.test(listGameName)) {
                          // Parse and update the specific game listed
                          // TODO: Implement client-side parsing of LIST output or rely solely on server-pushed refreshedGameState
                          console.log(`Received LIST output for ${listGameName}, but no client-side parser exists. Output:\n${stdout}`);
                     } else if (!listGameName) {
                          // Handle global LIST output? Maybe update the game selector?
                          // For now, just display the output. Server sync handles DB updates.
                          console.log("Global LIST command executed.");
                     }
                 }

            } else { // result.success is false
                outputDiv.classList.remove('text-green-700', 'text-orange-700');
                outputDiv.classList.add('text-red-700');
                outputDiv.textContent = `Error: ${result.output || 'Unknown error'}`;
            }

        } catch (error) {
            console.error('Fetch Error:', error);
            outputDiv.textContent = `Client or Network Error: ${error.message}`;
            outputDiv.classList.remove('text-green-700', 'text-orange-700');
            outputDiv.classList.add('text-red-700');
        } finally {
            sendButton.disabled = false;
            sendButton.textContent = 'Send Command';
            sendButton.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }

    if (sendButton) {
        sendButton.addEventListener('click', () => sendCommand());
    }

    // Save credentials on blur from password/variant fields
    if (targetPasswordInput) {
        targetPasswordInput.addEventListener('blur', saveCredentialsForGame);
    }
    if (targetVariantInput) {
        targetVariantInput.addEventListener('blur', saveCredentialsForGame); // Added listener
    }
    // --- Text Area Enter Key Listener ---
    if (generatedCommandTextarea) {
        generatedCommandTextarea.addEventListener('keydown', (event) => {
            // Send on Enter, allow Shift+Enter for newline
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault(); // Prevent newline
                sendCommand();
            }
        });
    }

    // --- Initial Load ---
    initializeDashboard();
    // Store user email in body dataset for client-side use if needed
    const userEmailElement = document.querySelector('#user-email-indicator'); // Assuming you add an element like <span id="user-email-indicator" data-email="<%= email %>"></span>
    if (userEmailElement) {
         document.body.dataset.userEmail = userEmailElement.dataset.email;
    }

}); // End DOMContentLoaded