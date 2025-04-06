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
    // console.log(`Cookie set: ${name}=${value}`); // Reduce console noise
}

function getCookie(name) {
    const nameEQ = name + "=";
    const ca = document.cookie.split(';');
    for (let i = 0; i < ca.length; i++) {
        let c = ca[i];
        while (c.charAt(0) == ' ') c = c.substring(1, c.length);
        if (c.indexOf(nameEQ) == 0) {
            const value = c.substring(nameEQ.length, c.length);
            // console.log(`Cookie get: ${name}=${value}`); // Reduce console noise
            return value;
        }
    }
    // console.log(`Cookie get: ${name}=null`); // Reduce console noise
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
    const userEmailIndicator = document.getElementById('user-email-indicator');

    let currentGameData = null; // Store the detailed state of the selected game
    let allGamesList = []; // Store the list of all games for the selector
    let currentUserEmail = userEmailIndicator ? userEmailIndicator.dataset.email : null; // Store user email

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
                    } else {
                         updateGameStateSidebar(null); // Show empty state
                         updateCommandGenerator(null); // Show default recommendations
                         loadCredentialsForGame(null); // Ensure clear if no initial game
                         console.log("No initial game cookie or no games found.");
                    }
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
        const currentSelectedGame = gameSelector.value; // Preserve selection if possible
        gameSelector.innerHTML = '<option value="">-- Select Target Game --</option>'; // Default option
        games.sort((a, b) => a.name.localeCompare(b.name)).forEach(game => {
            const option = document.createElement('option');
            option.value = game.name;
            option.textContent = `${game.name} (${game.status || 'Unknown'})`;
            gameSelector.appendChild(option);
        });
        // Restore selection if it still exists
        if (currentSelectedGame && gameSelector.querySelector(`option[value="${currentSelectedGame}"]`)) {
            gameSelector.value = currentSelectedGame;
        }
    }

    // --- Game State Handling ---
    function fetchAndDisplayGameState(gameName) {
        if (!gameName) {
            currentGameData = null;
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
                    console.log("[fetchAndDisplayGameState] Received game state and recommendations:", data);
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
                    <li class="${p.email === currentUserEmail ? 'font-semibold text-blue-700' : ''}">
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
                ${Object.entries(gameState.settings).sort(([keyA], [keyB]) => keyA.localeCompare(keyB)).map(([key, value]) => {
                    // Simple formatting for boolean/string/number
                    let displayValue = value;
                    if (typeof value === 'boolean') displayValue = value ? 'Yes' : 'No';
                    // Capitalize key
                    const displayKey = key.charAt(0).toUpperCase() + key.slice(1);
                    return `<li>${displayKey}: ${displayValue}</li>`;
                }).join('')}
            </ul>`
            : 'N/A';

        const lastUpdatedStr = gameState.lastUpdated ? new Date(gameState.lastUpdated * 1000).toLocaleString() : 'N/A';
        const observerLink = `https://www.floc.net/observer.py?partie=${gameState.name}`;

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
            targetPasswordInput.value = getCookie(`targetPassword_${gameName}`) || '';
            targetVariantInput.value = getCookie(`targetVariant_${gameName}`) || ''; // Set variant input
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
        console.log('[updateCommandGenerator] Updating dropdown with recommendations:', recommendedCommands); // Add logging

        const currentSelection = commandTypeSelect.value; // Preserve selection if possible
        commandTypeSelect.innerHTML = '<option value="">-- Select Action --</option>'; // Clear existing options

        // Use fetched recommendations or a very basic default
        const commands = recommendedCommands || {
             recommended: [], gameInfo: ['LIST'], playerActions: [], settings: [], general: ['HELP', 'VERSION', 'MANUAL'], master: []
        };

        const addOptGroup = (label, commandList) => {
            if (commandList && commandList.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = label;
                optgroup.className = 'font-semibold bg-gray-100'; // Style optgroup
                commandList.forEach(cmd => {
                    // Exclude REGISTER/SIGN OFF from selector
                    if (cmd !== 'REGISTER' && cmd !== 'SIGN OFF') {
                        const option = document.createElement('option');
                        option.value = cmd;
                        option.textContent = cmd;
                        optgroup.appendChild(option);
                    }
                });
                if (optgroup.childElementCount > 0) { // Only add if it has options
                    commandTypeSelect.appendChild(optgroup);
                }
            }
        };

        // Add groups in a logical order
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

    // --- generateCommandOptions: Expanded significantly ---
    function generateCommandOptions(selectedCommand) {
        optionsArea.innerHTML = ''; // Clear previous options
        generatedCommandTextarea.value = ''; // Clear textarea
        generatedCommandTextarea.placeholder = "Configure options above or type command here directly. Do NOT include SIGN OFF."; // Reset placeholder

        const targetGame = targetGameInput.value || '<game>'; // Use selected game or placeholder
        const inputClass = 'input text-sm'; // Consistent input styling
        const labelClass = 'block text-sm font-medium text-gray-700 mb-1';
        const helpTextClass = 'text-xs text-gray-500 mt-1';
        const checkboxClass = 'rounded border-gray-300 text-primary focus:ring-primary mr-2';

        // Helper to create form elements
        const createInput = (id, type, label, placeholder = '', required = false, value = '', help = '', otherAttrs = {}) => {
            let attrsString = '';
            for (const [key, val] of Object.entries(otherAttrs)) {
                attrsString += ` ${key}="${val}"`;
            }
            return `
                <div>
                    <label for="${id}" class="${labelClass}">${label}${required ? '<span class="text-red-500">*</span>' : ''}:</label>
                    <input type="${type}" id="${id}" name="${id}" class="${inputClass}" placeholder="${placeholder}" ${required ? 'required' : ''} value="${value}" ${attrsString}>
                    ${help ? `<p class="${helpTextClass}">${help}</p>` : ''}
                </div>`;
        };
        const createTextarea = (id, label, placeholder = '', required = false, rows = 3, help = '') => {
             return `
                <div>
                    <label for="${id}" class="${labelClass}">${label}${required ? '<span class="text-red-500">*</span>' : ''}:</label>
                    <textarea id="${id}" name="${id}" class="${inputClass} font-mono min-h-[${rows * 1.5}rem] resize-y" placeholder="${placeholder}" ${required ? 'required' : ''} rows="${rows}"></textarea>
                    ${help ? `<p class="${helpTextClass}">${help}</p>` : ''}
                </div>`;
        };
        const createSelect = (id, label, options, required = false, help = '') => {
            const optionsHtml = options.map(opt => `<option value="${opt.value}" ${opt.selected ? 'selected' : ''}>${opt.text}</option>`).join('');
            return `
                <div>
                    <label for="${id}" class="${labelClass}">${label}${required ? '<span class="text-red-500">*</span>' : ''}:</label>
                    <select id="${id}" name="${id}" class="${inputClass}" ${required ? 'required' : ''}>${optionsHtml}</select>
                    ${help ? `<p class="${helpTextClass}">${help}</p>` : ''}
                </div>`;
        };
         const createCheckbox = (id, label, checked = false, help = '') => {
             return `
                <div class="flex items-center">
                    <input type="checkbox" id="${id}" name="${id}" class="${checkboxClass}" ${checked ? 'checked' : ''}>
                    <label for="${id}" class="text-sm font-medium text-gray-700">${label}</label>
                    ${help ? `<p class="${helpTextClass} ml-1">${help}</p>` : ''}
                </div>`;
         };
         const createSeparator = () => '<hr class="my-3 border-gray-200">';
         const createInfo = (text) => `<p class="text-sm text-gray-600">${text}</p>`;
         const createWarning = (text) => `<p class="text-sm text-orange-600">${text}</p>`;
         const createError = (text) => `<p class="text-sm text-red-600">${text}</p>`;

        let content = '<div class="space-y-3">'; // Use consistent spacing

        // --- Add cases based on commands available in njudgedocs.txt ---
        switch (selectedCommand) {
            // --- General / Info ---
            case 'GET':
                content += createInput('get-filename', 'text', 'Filename', 'e.g., info, rules, map, guide, form, flist', true, '', 'See GET flist for available files.');
                break;
            case 'HELP':
            case 'VERSION':
                content += createInfo(`No parameters needed for ${selectedCommand}.`);
                break;
            case 'WHOIS':
                content += createInput('whois-email', 'text', 'Email Address (or start of)', 'e.g., user@ or user@domain.com', true);
                break;
            case 'LIST':
                content += createInput('list-game-name', 'text', 'Game Name (optional)', targetGame !== '<game>' ? targetGame : '', false, '', 'Leave blank for global list.');
                content += createCheckbox('list-full', 'Full List (if no game name)?', false, 'Shows player details for all games.');
                break;
            case 'HISTORY':
                content += createInput('hist-game-name', 'text', 'Game Name', targetGame !== '<game>' ? targetGame : '', true);
                content += createSeparator();
                content += createInput('hist-from', 'text', 'From Date (optional)', 'e.g., Jan 1 2023 or S1901M', false, '', 'Defaults to 1 week ago.');
                content += createInput('hist-to', 'text', 'To Date (optional)', 'e.g., Dec 31 2023 or F1905B', false, '', 'Defaults to now.');
                content += createInput('hist-lines', 'number', 'Max Lines (optional)', 'e.g., 5000', false, '', 'Defaults to 1000.');
                content += createSeparator();
                content += createInfo('OR Exclude Range:');
                content += createInput('hist-exclstart', 'text', 'EXCLSTART turnId', 'e.g., S1903M', false, '', 'Start of range to exclude.');
                content += createInput('hist-exclend', 'text', 'EXCLEND turnId', 'e.g., F1905B', false, '', 'End of range to exclude (optional).');
                content += createCheckbox('hist-broad', 'Include Broadcasts (with EXCL)?', false);
                break;
            case 'SUMMARY':
                content += createInput('summary-game-name', 'text', 'Game Name', targetGame !== '<game>' ? targetGame : '', true);
                break;
            case 'WHOGAME':
                content += createInput('whogame-game-name', 'text', 'Game Name', targetGame !== '<game>' ? targetGame : '', true);
                content += createCheckbox('whogame-full', 'Include Observers (FULL)?', false);
                break;
            case 'MAP': // Deprecated but included
                content += createWarning('MAP command is deprecated. Use Floc.net link in sidebar.');
                content += createInput('map-game-name', 'text', 'Game Name or *', targetGame !== '<game>' ? targetGame : '', true);
                content += createCheckbox('map-n', 'Plain Postscript (N)?', false);
                break;

            // --- Registration / User Account ---
            case 'REGISTER': // Should not be selectable, handled by separate page
                 content += createError('Registration is handled via the /register page, not this command generator.');
                 break;
            case 'I AM ALSO':
                 content += createInput('iamalso-old-email', 'email', 'Old Email Address', 'registered@example.com', true, '', 'The email address previously registered with this judge.');
                 content += createInfo('Send this command from your NEW email address.');
                 break;
            case 'SET PASSWORD':
                 content += createInput('setpass-new-password', 'password', 'New Password', '', true, '', 'Changes password for ALL games on this judge.');
                 break;
            case 'SET ADDRESS':
                 content += createInput('setaddr-new-email', 'email', 'New Reply-To Email (optional)', 'new@example.com', false, '', 'Leave blank to use sending address. Affects ALL games.');
                 break;
            case 'GET DEDICATION':
            case 'INFO PLAYER':
                 content += createInput('infoplayer-email', 'email', 'Email Address', currentUserEmail || '', true, '', `Defaults to your email (${currentUserEmail}).`);
                 break;

            // --- Joining / Creating / Observing ---
            case 'CREATE ?':
                 content += createInput('create-game-name', 'text', 'New Game Name', 'e.g., newgame', true, '', 'Max 8 alphanumeric chars.', {maxlength: 8});
                 content += createInput('create-password', 'password', 'Password', '', true);
                 content += createInput('create-variant', 'text', 'Variant/Options (optional)', 'e.g., Chaos Gunboat', false, '', 'Separate multiple options with spaces.');
                 content += createCheckbox('create-become-master', 'Become Master?', false, 'Adds BECOME MASTER command.');
                 break;
            case 'SIGN ON ?':
                 content += createInput('signon-next-password', 'password', 'Password', '', true, '', 'Password for the next available forming game.');
                 break;
            case 'SIGN ON ?game':
                 content += createInput('signon-q-game', 'text', 'Game Name', targetGame !== '<game>' ? targetGame : '', true, '', 'Name of the specific forming game.');
                 content += createInput('signon-q-password', 'password', 'Password', '', true);
                 content += createInput('signon-q-variant', 'text', 'Variant/Options (if required)', 'e.g., Chaos Gunboat', false, '', 'Must match game settings if specified.');
                 break;
            case 'SIGN ON power':
                 content += createInput('signon-power', 'text', 'Power Initial', 'e.g., F', true, '', 'Single letter (A, E, F, G, I, R, T for standard).', {size: 1, maxlength: 1});
                 content += createInput('signon-game', 'text', 'Game Name', targetGame !== '<game>' ? targetGame : '', true);
                 content += createInput('signon-password', 'password', 'Password', '', true);
                 break;
            case 'OBSERVE': case 'WATCH':
                 content += createInput('observe-game', 'text', 'Game Name', targetGame !== '<game>' ? targetGame : '', true);
                 content += createInput('observe-password', 'password', 'Password', '', true);
                 break;

            // --- In-Game Player Actions ---
            case 'ORDERS':
                 content += createInfo('Enter orders directly into the text area below.');
                 content += createInfo('Example: <code class="bg-gray-100 px-1 py-0.5 rounded">A Par H</code>, <code class="bg-gray-100 px-1 py-0.5 rounded">F Lon - Nth</code>');
                 content += createInfo('Separate multiple orders with newlines or commas.');
                 content += createWarning('Specify full convoy routes: <code class="bg-gray-100 px-1 py-0.5 rounded">A Lon-Nth-Nwy</code>');
                 generatedCommandTextarea.placeholder = "Enter orders here...\ne.g., A PAR H\nF BRE - MAO";
                 break;
            case 'PRESS': case 'BROADCAST': case 'POSTAL PRESS':
                 content += createInput('press-options', 'text', 'Press Options', 'e.g., TO FRG, GREY, FAKE TO A', false, '', 'See docs for TO, GREY, FAKE, etc.');
                 content += createTextarea('press-body', 'Press Message Body', '', true, 4);
                 content += createInfo(`Command will be: ${selectedCommand} [options]\\n[body]\\nENDPRESS`);
                 if (selectedCommand === 'POSTAL PRESS') content += createWarning('Postal Press is broadcast-only and delivered after the turn processes.');
                 generatedCommandTextarea.placeholder = "Enter message body here...";
                 break;
            case 'DIARY':
                 content += createSelect('diary-action', 'Action', [
                     {value: 'RECORD', text: 'RECORD Entry', selected: true},
                     {value: 'LIST', text: 'LIST Entries'},
                     {value: 'READ', text: 'READ Entry'},
                     {value: 'DELETE', text: 'DELETE Entry'}
                 ], true);
                 content += `<div id="diary-entry-num-div" class="hidden">${createInput('diary-entry-num', 'number', 'Entry Number (for READ/DELETE)', '', false)}</div>`;
                 content += `<div id="diary-body-div">${createTextarea('diary-body', 'Diary Entry Body (for RECORD)', '', false, 5)}</div>`;
                 content += createInfo('For RECORD, the command will be: DIARY RECORD\\n[body]\\nENDPRESS');
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
                         qs('#diary-entry-num').required = (action === 'READ' || action === 'DELETE');
                         qs('#diary-body').required = (action === 'RECORD');
                         updateGeneratedCommandText(); // Update command text when visibility changes
                     };
                     actionSelect.addEventListener('change', updateDiaryFields);
                     updateDiaryFields(); // Initial setup
                 }, 0);
                 generatedCommandTextarea.placeholder = "Enter diary entry body here for RECORD...";
                 break;
            case 'RESIGN': case 'WITHDRAW':
                 content += createInfo(`No parameters needed for ${selectedCommand}.`);
                 content += createWarning('This must be the last command in the message.');
                 break;

            // --- In-Game Player Settings / Future Orders ---
             case 'SET WAIT': case 'SET NOWAIT': case 'SET NOABSENCE': case 'SET NODRAW': case 'SET NOCONCEDE': case 'CLEAR':
                 content += createInfo(`No parameters needed for ${selectedCommand}.`);
                 break;
             case 'SET ABSENCE': case 'SET HOLIDAY': case 'SET VACATION': // Synonyms
                 content += createInput('absence-start', 'text', 'Start Date', 'e.g., Jan 1 2024 or Mon', true);
                 content += createInput('absence-end', 'text', 'End Date (optional)', 'e.g., Jan 15 2024 or Fri', false, '', 'Defaults to 24h after start.');
                 content += createInfo('Affects future deadlines, not the current one.');
                 break;
             case 'SET DRAW':
                 content += createInput('draw-powers', 'text', 'Powers to include (optional)', 'e.g., AEFG (NoDIAS only)', false, '', 'Leave blank for DIAS or to include self only in NoDIAS.');
                 break;
             case 'SET CONCEDE':
                 content += createInput('concede-power', 'text', 'Power Initial to Concede To', 'e.g., F', true, '', '', {size: 1, maxlength: 1});
                 break;
             case 'SET PREFERENCE':
                 content += createInput('preference-list', 'text', 'Preference List', 'e.g., E[FGR][TAI] or *', true, '', 'Only effective in forming games.');
                 break;
             case 'PHASE':
                 content += createSelect('phase-season', 'Season', [
                     {value: 'Spring', text: 'Spring'}, {value: 'Summer', text: 'Summer (Variant)'},
                     {value: 'Fall', text: 'Fall'}, {value: 'Winter', text: 'Winter'}
                 ], true);
                 content += createInput('phase-year', 'number', 'Year', 'e.g., 1905', true);
                 content += createSelect('phase-type', 'Phase Type', [
                     {value: 'Movement', text: 'Movement'}, {value: 'Retreat', text: 'Retreat'},
                     {value: 'Adjustment', text: 'Adjustment/Build'}
                 ], true);
                 content += createInfo('Enter orders for this future phase below the generated command.');
                 generatedCommandTextarea.placeholder = "Enter future orders here after PHASE command...";
                 break;
             case 'IF':
                 content += createTextarea('if-condition', 'Condition', 'e.g., NOT French Army Ruhr AND (Russian Prussia OR Russian Silesia)', true, 2);
                 content += createInfo('Enter orders for the IF block below, optionally followed by ELSE/ENDIF.');
                 generatedCommandTextarea.placeholder = "IF condition\n  Order1\nELSE\n  Order2\nENDIF";
                 break;

            // --- Master Commands ---
             case 'BECOME MASTER':
                 content += createWarning('Master Only (usually used with CREATE).');
                 content += createInfo('Makes the game moderated and assigns you as Master.');
                 break;
             case 'SET MODERATE': case 'SET UNMODERATE':
                 content += createWarning('Master Only.');
                 content += createInfo(`Changes game moderation status (${selectedCommand.substring(4)}).`);
                 break;
             case 'BECOME':
                 content += createWarning('Master Only.');
                 content += createInput('become-power', 'text', 'Power Initial or Name', 'e.g., F or France', true);
                 content += createInfo('Enter commands to be executed as this power below.');
                 generatedCommandTextarea.placeholder = "Enter commands to run as the specified power...";
                 break;
             case 'EJECT':
                 content += createWarning('Master Only.');
                 content += createInput('eject-target', 'text', 'Power Initial or Observer Email', 'e.g., F or observer@example.com', true);
                 break;
             case 'FORCE BEGIN':
                 content += createWarning('Master Only.');
                 content += createInfo('Forces a forming game to start, filling empty slots with abandoned dummies.');
                 break;
             case 'PAUSE': case 'RESUME': case 'TERMINATE':
                 content += createWarning('Master Only.');
                 content += createInfo(`No parameters needed for ${selectedCommand}.`);
                 break;
             case 'PREDICT':
                 content += createWarning('Master Only.');
                 content += createInfo('Sends prediction of current turn based on submitted orders to Master.');
                 break;
             case 'PROMOTE':
                 content += createWarning('Master Only.');
                 content += createInput('promote-observer', 'email', 'Observer Email to Promote', 'observer@example.com', true);
                 break;
             case 'PROCESS':
                 content += createWarning('Master Only.');
                 content += createInput('process-phase', 'text', 'Phase to Process (optional)', 'e.g., F1905R or Fall 1905 Retreat', false, '', 'Recommended to prevent accidental processing.');
                 break;
             case 'ROLLBACK':
                 content += createWarning('Master Only.');
                 content += createInput('rollback-turn', 'number', 'Turn Number (optional)', 'e.g., 001', false, '', 'Defaults to last turn. Use 001 to rollback to start.');
                 break;
             case 'UNSTART':
                 content += createWarning('Master Only.');
                 content += createInfo('Returns game to pre-start state. Only works if no turns processed.');
                 break;

            // --- Master Settings ---
             case 'SET': // Generic SET
                 content += createWarning('Master Only. Use specific SET commands if available.');
                 content += createInput('set-option', 'text', 'Option to Set', 'e.g., DEADLINE, VARIANT, NMR, PRESS', true);
                 content += createInput('set-value', 'text', 'Value', 'e.g., Mon Jan 1 2024 23:00, Standard Gunboat, ON, GREY', true);
                 break;
             // Add specific SET commands here if desired, or rely on generic SET / MANUAL
             case 'SET DEADLINE': case 'SET GRACE': case 'SET START':
                 content += createWarning('Master Only.');
                 content += createInput(`set-${selectedCommand.toLowerCase()}-date`, 'text', 'Date/Time', 'e.g., Mon Jan 1 23:00 or +24h', true);
                 break;
             case 'SET COMMENT':
                 content += createWarning('Master Only.');
                 content += createInput('set-comment-text', 'text', 'Comment Text', '', true, '', 'Short comment for brief LIST output.');
                 break;
             case 'SET COMMENT BEGIN':
                  content += createWarning('Master Only.');
                  content += createTextarea('set-comment-begin-text', 'Comment Text', '', true, 4, 'Long comment for full LIST output. Ends with SIGN OFF.');
                  break;
             // Example: SET NMR / SET NO NMR
             case 'SET NMR': case 'SET NO NMR': case 'SET CD': case 'SET NO CD': // CD is synonym for NMR
                 content += createWarning('Master Only.');
                 content += createInfo(`Sets NMR (No Move Retreat) status to ${selectedCommand.startsWith('SET NO') ? 'OFF' : 'ON'}.`);
                 break;
             // Example: SET VARIANT
             case 'SET VARIANT':
                 content += createWarning('Master Only (before game start).');
                 content += createInput('set-variant-name', 'text', 'Variant/Option Name', 'e.g., Chaos or Gunboat', true);
                 break;
             case 'SET NOT VARIANT':
                  content += createWarning('Master Only (before game start).');
                  content += createInput('set-not-variant-name', 'text', 'Option Name to Remove', 'e.g., Gunboat', true);
                  break;
             // Add other SET commands based on docs...
             case 'SET ALL PRESS': case 'SET NORMAL PRESS': case 'SET QUIET': case 'SET NO QUIET':
             case 'SET WATCH ALL PRESS': case 'SET NO WATCH ALL PRESS': case 'SET ACCESS':
             case 'SET ALLOW PLAYER': case 'SET DENY PLAYER': case 'SET LEVEL': case 'SET DEDICATION':
             case 'SET ONTIMERAT': case 'SET RESRAT': case 'SET APPROVAL': case 'SET APPROVE': case 'SET NOT APPROVE':
             case 'SET BLANK PRESS': case 'SET BROADCAST': case 'SET NORMAL BROADCAST': case 'SET NO FAKE':
             case 'SET GREY': case 'SET NO WHITE': case 'SET GREY/WHITE': case 'SET LATE PRESS':
             case 'SET MINOR PRESS': case 'SET MUST ORDER': case 'SET NO PRESS': case 'SET NONE':
             case 'SET OBSERVER': case 'SET PARTIAL': case 'SET PARTIAL FAKES BROADCAST': case 'SET PARTIAL MAY':
             case 'SET POSTAL PRESS': case 'SET WHITE': case 'SET WHITE/GREY': case 'SET MAX ABSENCE':
             case 'SET LATE COUNT': case 'SET STRICT GRACE': case 'SET STRICT WAIT': case 'SET MOVE':
             case 'SET RETREAT': case 'SET ADJUST': case 'SET CONCESSIONS': case 'SET DIAS': case 'SET LIST':
             case 'SET PUBLIC': case 'SET PRIVATE': case 'SET AUTO PROCESS': case 'SET MANUAL PROCESS':
             case 'SET AUTO START': case 'SET MANUAL START': case 'SET RATED': case 'SET UNRATED':
             case 'SET ANY CENTER': case 'SET ANY DISBAND': case 'SET ATTACK TRANSFORM': case 'SET AUTO DISBAND':
             case 'SET BCENTERS': case 'SET BLANK BOARD': case 'SET EMPTY BOARD': case 'SET CENTERS':
             case 'SET COASTAL CONVOYS': case 'SET DISBAND': case 'SET DUALITY': case 'SET GATEWAYS':
             case 'SET HOME CENTER': case 'SET HONG KONG': case 'SET NORMAL DISBAND': case 'SET ONE CENTER':
             case 'SET PLAYERS': case 'SET PORTAGE': case 'SET POWERS': case 'SET PROXY': case 'SET RAILWAYS':
             case 'SET REVEAL': case 'SET SECRET': case 'SET SHOW': case 'SET SUMMER': case 'SET TOUCH PRESS':
             case 'SET TRANSFORM': case 'SET TRAFO': case 'SET ADJACENT': case 'SET ADJACENCY':
             case 'SET ASSASSINS': case 'SET ASSASSINATION': case 'SET BANK': case 'SET BANKERS': case 'SET LOANS':
             case 'SET DICE': case 'SET FAMINE': case 'SET FORT': case 'SET FORTRESS': case 'SET GARRISON':
             case 'SET MACH2': case 'SET MONEY': case 'SET PLAGUE': case 'SET SPECIAL': case 'SET STORM':
                  // Generic handler for simple SET commands
                  content += createWarning('Master Only.');
                  content += createInfo(`Applies setting: ${selectedCommand}. Check docs for specific value requirements if any.`);
                  content += createInfo(`Enter value directly in text area if needed (e.g., SET LEVEL EXPERT).`);
                  generatedCommandTextarea.value = selectedCommand + ' '; // Start with command
                  break;


            // --- Manual / Default ---
             case 'MANUAL':
                 content += createInfo('Enter the full command manually in the text area below. Do NOT include SIGN OFF.');
                 content += createInfo('The server will prepend SIGN ON automatically if needed for the target game.');
                 generatedCommandTextarea.placeholder = "Type full command here (e.g., WHOIS someone@example.com)";
                 break;
            default:
                content += createInfo(`Parameters for <strong>${selectedCommand}</strong> (if any) should be entered directly in the text area below.`);
                content += createInfo(`Check <code class="bg-gray-100 px-1 py-0.5 rounded">HELP ${selectedCommand}</code> if unsure.`);
                generatedCommandTextarea.value = selectedCommand + ' '; // Start with the command verb
                break;
        }
        content += '</div>'; // Close space-y-3
        optionsArea.innerHTML = content;

        // Attach listeners to new inputs/selects/textareas AFTER they are in the DOM
        setTimeout(() => {
            optionsArea.querySelectorAll('input, select, textarea').forEach(el => {
                // Use 'input' for text fields, 'change' for select/checkbox
                const eventType = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio') ? 'change' : 'input';
                el.removeEventListener(eventType, updateGeneratedCommandText); // Remove old listener if any
                el.addEventListener(eventType, updateGeneratedCommandText);
            });
            updateGeneratedCommandText(); // Update text area based on initial options
        }, 0); // Timeout ensures DOM update is processed
    }

    // Helper function to query selector safely within optionsArea
    const qs = (selector) => optionsArea.querySelector(selector);

    // --- updateGeneratedCommandText: Updated for multi-line and complex commands ---
    function updateGeneratedCommandText() {
        if (!commandTypeSelect || !generatedCommandTextarea) return;

        const selectedCommand = commandTypeSelect.value;
        if (!selectedCommand) {
            // Don't clear if user might be typing manually
            // generatedCommandTextarea.value = '';
            return;
        }

        let commandString = '';
        let commandBody = '';
        const currentText = generatedCommandTextarea.value; // Preserve user input if possible

        // Build the command string based on options
        commandString = buildCommandStringFromOptions(selectedCommand);

        // Handle commands where the textarea is primarily for the body
        const commandsWithBodyInput = ['ORDERS', 'PRESS', 'BROADCAST', 'POSTAL PRESS', 'DIARY', 'PHASE', 'IF', 'BECOME', 'SET COMMENT BEGIN'];
        if (commandsWithBodyInput.includes(selectedCommand)) {
            // Try to preserve existing body if user was editing it
            const lines = currentText.split('\n');
            let potentialBodyStartLine = 0;

            // Find where the generated command string ends
            const generatedLines = commandString.split('\n');
            potentialBodyStartLine = generatedLines.length;

            // Special case: If commandString is empty (ORDERS, MANUAL), body is everything
            if (!commandString) {
                 potentialBodyStartLine = 0;
            }

            // Check if the current text seems to contain the generated command prefix
            let prefixMatches = true;
            if (potentialBodyStartLine > 0) {
                for(let i = 0; i < potentialBodyStartLine; i++) {
                    // Allow for potential whitespace differences when comparing prefix
                    if (i >= lines.length || lines[i].trim() !== generatedLines[i].trim()) {
                        prefixMatches = false;
                        break;
                    }
                }
            } else {
                 prefixMatches = false; // No prefix generated, assume body is new or full content
            }


            if (prefixMatches && lines.length >= potentialBodyStartLine) { // Use >= to handle case where body is empty
                 // Assume lines after the generated command are the user's body input
                 commandBody = lines.slice(potentialBodyStartLine).join('\n');
            } else if (selectedCommand === 'ORDERS' || selectedCommand === 'MANUAL') {
                 // For these, the entire textarea is the command/body
                 commandBody = currentText;
                 commandString = ''; // No prefix
            } else {
                 // Generate default/placeholder body if needed
                 if (['PRESS', 'BROADCAST', 'POSTAL PRESS'].includes(selectedCommand)) {
                     commandBody = qs('#press-body')?.value || ''; // Get value from textarea if exists
                     if (!commandBody && currentText.includes('ENDPRESS')) commandBody = ''; // Keep empty if user cleared it
                     else if (!commandBody) commandBody = '<message body>'; // Placeholder
                     commandBody += '\nENDPRESS';
                 } else if (selectedCommand === 'DIARY' && qs('#diary-action')?.value === 'RECORD') {
                     commandBody = qs('#diary-body')?.value || '';
                     if (!commandBody && currentText.includes('ENDPRESS')) commandBody = '';
                     else if (!commandBody) commandBody = '<diary entry>';
                     commandBody += '\nENDPRESS';
                 } else if (['PHASE', 'IF', 'BECOME'].includes(selectedCommand)) {
                     commandBody = '<orders/commands>'; // Placeholder
                 } else if (selectedCommand === 'SET COMMENT BEGIN') {
                     commandBody = qs('#set-comment-begin-text')?.value || '<long comment text>';
                 }
                 // If prefix didn't match, reset body unless it's ORDERS/MANUAL
                 if (!prefixMatches && selectedCommand !== 'ORDERS' && selectedCommand !== 'MANUAL') {
                      // Use generated placeholder body
                 } else if (!prefixMatches && (selectedCommand === 'ORDERS' || selectedCommand === 'MANUAL')) {
                      commandBody = currentText; // Keep user's text
                 }
            }
        }

        // Construct final output
        let finalOutput = commandString;
        if (commandBody && commandsWithBodyInput.includes(selectedCommand)) {
            if (finalOutput.length > 0 && !finalOutput.endsWith('\n')) {
                finalOutput += '\n';
            }
            finalOutput += commandBody;
        } else if (!commandString && (selectedCommand === 'ORDERS' || selectedCommand === 'MANUAL')) {
             finalOutput = commandBody; // Body is the whole command
        }

        // Only update if the generated text is different from current text,
        // to avoid cursor jumping during manual edits in body section.
        if (generatedCommandTextarea.value !== finalOutput) {
             const cursorPos = generatedCommandTextarea.selectionStart;
             const oldLength = generatedCommandTextarea.value.length;
             generatedCommandTextarea.value = finalOutput;
             // Try to restore cursor position intelligently
             try {
                 // If cursor was at the end, keep it at the end
                 if (cursorPos === oldLength) {
                     generatedCommandTextarea.setSelectionRange(finalOutput.length, finalOutput.length);
                 }
                 // If cursor was within the text, try to keep it there
                 else if (cursorPos <= finalOutput.length) {
                     generatedCommandTextarea.setSelectionRange(cursorPos, cursorPos);
                 }
                 // Otherwise, default to end
                 else {
                      generatedCommandTextarea.setSelectionRange(finalOutput.length, finalOutput.length);
                 }
             } catch (e) {
                 console.warn("Could not restore cursor position:", e);
                 // Fallback: place cursor at the end
                 generatedCommandTextarea.setSelectionRange(finalOutput.length, finalOutput.length);
             }
        }
    }

    // Helper to build the command string from options (first line usually)
    function buildCommandStringFromOptions(selectedCommand) {
        let commandString = selectedCommand;
        // Use safe query selector helper 'qs' defined above
        const val = (selector, defaultValue = '') => qs(selector)?.value.trim() || defaultValue;
        const checked = (selector) => qs(selector)?.checked || false;
        const rawVal = (selector, defaultValue = '') => qs(selector)?.value || defaultValue; // Don't trim passwords

        switch (selectedCommand) {
            // --- General / Info ---
            case 'GET': commandString = `GET ${val('#get-filename', '<filename>')}`; break;
            case 'WHOIS': commandString = `WHOIS ${val('#whois-email', '<email_or_prefix>')}`; break;
            case 'LIST': const gameNameList = val('#list-game-name'); commandString = 'LIST'; if (gameNameList) { commandString += ` ${gameNameList}`; } else if (checked('#list-full')) { commandString += ' FULL'; } break;
            case 'HISTORY': const gameNameHist = val('#hist-game-name', '<game>'); commandString = `HISTORY ${gameNameHist}`; const exclStart = val('#hist-exclstart'); if (exclStart) { commandString += ` EXCLSTART ${exclStart}`; const exclEnd = val('#hist-exclend'); if (exclEnd) commandString += ` EXCLEND ${exclEnd}`; if (checked('#hist-broad')) commandString += ` BROAD`; } else { const fromDate = val('#hist-from'); const toDate = val('#hist-to'); const lines = val('#hist-lines'); if (fromDate) commandString += ` FROM ${fromDate}`; if (toDate) commandString += ` TO ${toDate}`; if (lines) commandString += ` LINES ${lines}`; } break;
            case 'SUMMARY': commandString = `SUMMARY ${val('#summary-game-name', '<game>')}`; break;
            case 'WHOGAME': const gameNameWho = val('#whogame-game-name', '<game>'); commandString = `WHOGAME ${gameNameWho}`; if (checked('#whogame-full')) commandString += ' FULL'; break;
            case 'MAP': commandString = `MAP ${val('#map-game-name', '<game_or_*>')}`; if (checked('#map-n')) commandString += ' N'; break;

            // --- Registration / User Account ---
            case 'I AM ALSO': commandString = `I AM ALSO ${val('#iamalso-old-email', '<old_email>')}`; break;
            case 'SET PASSWORD': commandString = `SET PASSWORD ${rawVal('#setpass-new-password', '<new_password>')}`; break;
            case 'SET ADDRESS': const newAddr = val('#setaddr-new-email'); commandString = `SET ADDRESS`; if (newAddr) commandString += ` ${newAddr}`; break;
            case 'GET DEDICATION': case 'INFO PLAYER': commandString = `${selectedCommand} ${val('#infoplayer-email', currentUserEmail || '<email>')}`; break;

            // --- Joining / Creating / Observing ---
            case 'CREATE ?': const createGame = val('#create-game-name', '<name>'); const createPass = rawVal('#create-password', '<password>'); const createVariant = val('#create-variant'); commandString = `CREATE ?${createGame} ${createPass}`; if (createVariant) commandString += ` ${createVariant}`; if (checked('#create-become-master')) commandString += '\nBECOME MASTER'; break;
            case 'SIGN ON ?': commandString = `SIGN ON ? ${rawVal('#signon-next-password', '<password>')}`; break;
            case 'SIGN ON ?game': const gameQ = val('#signon-q-game', '<game>'); const passQ = rawVal('#signon-q-password', '<password>'); const variantQ = val('#signon-q-variant'); commandString = `SIGN ON ?${gameQ} ${passQ}`; if (variantQ) commandString += ` ${variantQ}`; break;
            case 'SIGN ON power': const power = val('#signon-power', '<P>').toUpperCase(); const gameP = val('#signon-game', '<game>'); const passP = rawVal('#signon-password', '<password>'); commandString = `SIGN ON ${power}${gameP} ${passP}`; break;
            case 'OBSERVE': case 'WATCH': commandString = `${selectedCommand} ${val('#observe-game', '<game>')} ${rawVal('#observe-password', '<password>')}`; break;

            // --- In-Game Player Actions ---
            case 'ORDERS': commandString = ''; break; // Body is handled separately
            case 'PRESS': case 'BROADCAST': case 'POSTAL PRESS': const pressOpts = val('#press-options'); commandString = selectedCommand; if (pressOpts) commandString += ` ${pressOpts}`; break; // Body handled separately
            case 'DIARY': const diaryAction = val('#diary-action'); commandString = `DIARY ${diaryAction}`; if (diaryAction === 'READ' || diaryAction === 'DELETE') { commandString += ` ${val('#diary-entry-num', '<number>')}`; } break; // Body handled separately for RECORD
            case 'RESIGN': case 'WITHDRAW': commandString = selectedCommand; break;

            // --- In-Game Player Settings / Future Orders ---
             case 'SET WAIT': case 'SET NOWAIT': case 'SET NOABSENCE': case 'SET NODRAW': case 'SET NOCONCEDE': case 'CLEAR': commandString = selectedCommand; break;
             case 'SET ABSENCE': case 'SET HOLIDAY': case 'SET VACATION': const absStart = val('#absence-start', '<start_date>'); const absEnd = val('#absence-end'); commandString = `SET ABSENCE ${absStart}`; if (absEnd) commandString += ` TO ${absEnd}`; break;
             case 'SET DRAW': const drawPowers = val('#draw-powers'); commandString = `SET DRAW`; if (drawPowers) commandString += ` ${drawPowers}`; break;
             case 'SET CONCEDE': commandString = `SET CONCEDE ${val('#concede-power', '<P>').toUpperCase()}`; break;
             case 'SET PREFERENCE': commandString = `SET PREFERENCE ${val('#preference-list', '<list_or_*>')}`; break;
             case 'PHASE': commandString = `PHASE ${val('#phase-season', '<Season>')} ${val('#phase-year', '<Year>')} ${val('#phase-type', '<Phase>')}`; break; // Body handled separately
             case 'IF': commandString = `IF ${val('#if-condition', '<condition>')}`; break; // Body handled separately

            // --- Master Commands ---
             case 'BECOME MASTER': case 'SET MODERATE': case 'SET UNMODERATE': case 'FORCE BEGIN': case 'PAUSE': case 'RESUME': case 'TERMINATE': case 'PREDICT': case 'UNSTART': commandString = selectedCommand; break;
             case 'BECOME': commandString = `BECOME ${val('#become-power', '<power>')}`; break; // Body handled separately
             case 'EJECT': commandString = `EJECT ${val('#eject-target', '<power_or_email>')}`; break;
             case 'PROMOTE': commandString = `PROMOTE ${val('#promote-observer', '<observer_email>')}`; break;
             case 'PROCESS': const procPhase = val('#process-phase'); commandString = `PROCESS`; if (procPhase) commandString += ` ${procPhase}`; break;
             case 'ROLLBACK': const rbTurn = val('#rollback-turn'); commandString = `ROLLBACK`; if (rbTurn) commandString += ` ${rbTurn}`; break;

            // --- Master Settings ---
             case 'SET': commandString = `SET ${val('#set-option', '<option>')} ${rawVal('#set-value', '<value>')}`; break;
             case 'SET DEADLINE': case 'SET GRACE': case 'SET START': commandString = `${selectedCommand} ${val(`set-${selectedCommand.toLowerCase()}-date`, '<date>')}`; break;
             case 'SET COMMENT': commandString = `SET COMMENT ${val('#set-comment-text', '<text>')}`; break;
             case 'SET COMMENT BEGIN': commandString = `SET COMMENT BEGIN`; break; // Body handled separately
             // Add other specific SET commands if needed, otherwise use generic SET or MANUAL
             case 'SET NMR': case 'SET NO NMR': case 'SET CD': case 'SET NO CD': commandString = selectedCommand; break;
             case 'SET VARIANT': commandString = `SET VARIANT ${val('#set-variant-name', '<variant_or_option>')}`; break;
             case 'SET NOT VARIANT': commandString = `SET NOT VARIANT ${val('#set-not-variant-name', '<option>')}`; break;
             // Generic handler for simple SET commands (most master settings)
             case 'SET ALL PRESS': case 'SET NORMAL PRESS': case 'SET QUIET': case 'SET NO QUIET':
             case 'SET WATCH ALL PRESS': case 'SET NO WATCH ALL PRESS': case 'SET ACCESS':
             case 'SET ALLOW PLAYER': case 'SET DENY PLAYER': case 'SET LEVEL': case 'SET DEDICATION':
             case 'SET ONTIMERAT': case 'SET RESRAT': case 'SET APPROVAL': case 'SET APPROVE': case 'SET NOT APPROVE':
             case 'SET BLANK PRESS': case 'SET BROADCAST': case 'SET NORMAL BROADCAST': case 'SET NO FAKE':
             case 'SET GREY': case 'SET NO WHITE': case 'SET GREY/WHITE': case 'SET LATE PRESS':
             case 'SET MINOR PRESS': case 'SET MUST ORDER': case 'SET NO PRESS': case 'SET NONE':
             case 'SET OBSERVER': case 'SET PARTIAL': case 'SET PARTIAL FAKES BROADCAST': case 'SET PARTIAL MAY':
             case 'SET POSTAL PRESS': case 'SET WHITE': case 'SET WHITE/GREY': case 'SET MAX ABSENCE':
             case 'SET LATE COUNT': case 'SET STRICT GRACE': case 'SET STRICT WAIT': case 'SET MOVE':
             case 'SET RETREAT': case 'SET ADJUST': case 'SET CONCESSIONS': case 'SET DIAS': case 'SET LIST':
             case 'SET PUBLIC': case 'SET PRIVATE': case 'SET AUTO PROCESS': case 'SET MANUAL PROCESS':
             case 'SET AUTO START': case 'SET MANUAL START': case 'SET RATED': case 'SET UNRATED':
             case 'SET ANY CENTER': case 'SET ANY DISBAND': case 'SET ATTACK TRANSFORM': case 'SET AUTO DISBAND':
             case 'SET BCENTERS': case 'SET BLANK BOARD': case 'SET EMPTY BOARD': case 'SET CENTERS':
             case 'SET COASTAL CONVOYS': case 'SET DISBAND': case 'SET DUALITY': case 'SET GATEWAYS':
             case 'SET HOME CENTER': case 'SET HONG KONG': case 'SET NORMAL DISBAND': case 'SET ONE CENTER':
             case 'SET PLAYERS': case 'SET PORTAGE': case 'SET POWERS': case 'SET PROXY': case 'SET RAILWAYS':
             case 'SET REVEAL': case 'SET SECRET': case 'SET SHOW': case 'SET SUMMER': case 'SET TOUCH PRESS':
             case 'SET TRANSFORM': case 'SET TRAFO': case 'SET ADJACENT': case 'SET ADJACENCY':
             case 'SET ASSASSINS': case 'SET ASSASSINATION': case 'SET BANK': case 'SET BANKERS': case 'SET LOANS':
             case 'SET DICE': case 'SET FAMINE': case 'SET FORT': case 'SET FORTRESS': case 'SET GARRISON':
             case 'SET MACH2': case 'SET MONEY': case 'SET PLAGUE': case 'SET SPECIAL': case 'SET STORM':
                  commandString = selectedCommand; // Simple SET command, value might be needed in text area
                  break;

            // --- Manual ---
             case 'MANUAL': commandString = ''; break; // Body is handled separately

            // --- Default ---
            default: commandString = selectedCommand; break; // Default to just the command verb if no options defined
        }
        return commandString;
    }


    // --- Event Listeners ---
    if (commandTypeSelect) {
        commandTypeSelect.addEventListener('change', () => {
            generateCommandOptions(commandTypeSelect.value);
        });
    }
    if (gameSelector) {
        gameSelector.addEventListener('change', () => {
            const selectedGame = gameSelector.value;
            fetchAndDisplayGameState(selectedGame); // This already fetches state AND recommendations
        });
    }
    if(refreshStateButton) {
        refreshStateButton.addEventListener('click', () => {
            const gameName = targetGameInput.value;
            if (gameName) {
                 outputDiv.textContent = `Refreshing state for ${gameName}...`;
                 outputDiv.className = 'bg-blue-50 border border-blue-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-blue-700';
                 sendCommand(`LIST ${gameName}`); // sendCommand will handle the refresh logic
            } else {
                alert('Please select a game to refresh.');
            }
        });
    }
     if (clearCredentialsButton) {
         clearCredentialsButton.addEventListener('click', clearAllCredentials);
     }
    if (targetPasswordInput) targetPasswordInput.addEventListener('blur', saveCredentialsForGame);
    if (targetVariantInput) targetVariantInput.addEventListener('blur', saveCredentialsForGame);


    async function sendCommand(commandOverride = null) {
        const commandToSend = commandOverride || generatedCommandTextarea.value.trim();
        const targetGame = targetGameInput.value;
        const targetPassword = targetPasswordInput.value;
        const targetVariant = targetVariantInput.value;

        if (!commandToSend) {
            outputDiv.textContent = 'Error: Command cannot be empty.';
            outputDiv.className = 'bg-red-50 border border-red-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-red-700';
            return;
        }

        // Context warning logic (keep as is)
        const commandVerb = commandToSend.split(/\s+/)[0].toUpperCase();
        const noContextCommands = ['REGISTER', 'WHOIS', 'INFO', 'GET', 'VERSION', 'HELP', 'LIST', 'SIGN', 'OBSERVE', 'WATCH', 'CREATE', 'MANUAL', 'SET PASSWORD', 'SET ADDRESS', 'I AM ALSO', 'GET DEDICATION', 'INFO PLAYER', 'SEND', 'MAP'];
        const gameNameOptionalCommands = ['LIST', 'HISTORY', 'SUMMARY', 'WHOGAME', 'OBSERVE', 'WATCH'];
        let needsContextCheck = true;
        if (noContextCommands.includes(commandVerb)) { needsContextCheck = false; }
        else if (gameNameOptionalCommands.includes(commandVerb)) {
             const commandParts = commandToSend.trim().split(/\s+/);
             if (commandParts.length > 1) {
                 const potentialGameName = commandParts[1];
                 const keywords = ['FULL', 'FROM', 'TO', 'LINES', 'EXCLSTART', 'EXCLEND', 'BROAD'];
                 if (/^[a-zA-Z0-9]{1,8}$/.test(potentialGameName) && !keywords.includes(potentialGameName.toUpperCase())) {
                     needsContextCheck = false;
                 }
             }
        }
        if (needsContextCheck && (!targetGame || !targetPassword)) {
             let warningMsg = !targetGame
                 ? `Warning: Command "${commandVerb}" likely requires a target game, but none is selected. Sending anyway...`
                 : `Warning: Command "${commandVerb}" likely requires the password for game "${targetGame}", but none is entered. Sending anyway...`;
             outputDiv.textContent = warningMsg;
             outputDiv.className = 'bg-orange-50 border border-orange-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-orange-700';
        } else {
             outputDiv.textContent = 'Sending command...';
             outputDiv.className = 'bg-gray-50 border border-gray-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-gray-700';
        }
        // End context warning logic

        sendButton.disabled = true;
        sendButton.textContent = 'Sending...';
        sendButton.classList.add('opacity-50', 'cursor-not-allowed');

        try {
            const response = await fetch('/execute-dip', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: commandToSend, targetGame, targetPassword, targetVariant }),
            });

            let result;
            const contentType = response.headers.get('content-type');
            if (response.ok && contentType && contentType.includes('application/json')) {
                 result = await response.json();
                 console.log("[sendCommand] Received result:", result);
            } else {
                 const errorText = await response.text();
                 throw new Error(`Server error ${response.status}: ${errorText || response.statusText}`);
            }

            outputDiv.textContent = result.output || 'No output received.';

            if (result.success) {
                outputDiv.classList.remove('text-red-700', 'text-orange-700', 'text-blue-700');
                outputDiv.classList.add('text-green-700');
                outputDiv.textContent = `Command Sent Successfully.\n\n${result.output}`;

                // --- State and Recommendation Update Logic ---
                let stateToUpdateUI = null;
                let recommendationsToUpdateUI = null; // *** ADDED ***

                if (result.refreshedGameState) {
                    console.log("[sendCommand] Using refreshedGameState from response.");
                    stateToUpdateUI = result.refreshedGameState;
                    // *** ADDED: Use recommendations sent directly from server ***
                    if (result.updatedRecommendedCommands) {
                        console.log("[sendCommand] Using updatedRecommendedCommands from response.");
                        recommendationsToUpdateUI = result.updatedRecommendedCommands;
                    }
                }

                if (result.isSignOnOrObserveSuccess) {
                    const confirmedGameName = result.createdGameName || targetGame;
                    outputDiv.textContent += `\n\nSign On / Observe / Create Successful for ${confirmedGameName}! Updating context...`;
                    if (confirmedGameName && gameSelector) {
                         if (!Array.from(gameSelector.options).some(opt => opt.value === confirmedGameName)) {
                              allGamesList.push({ name: confirmedGameName, status: 'Forming' });
                              populateGameSelector(allGamesList);
                         }
                         gameSelector.value = confirmedGameName;
                         targetGameInput.value = confirmedGameName;
                         loadCredentialsForGame(confirmedGameName);
                         // If state wasn't included in *this* response, fetch it explicitly
                         // This fetch will also get the correct recommendations
                         if (!stateToUpdateUI) {
                             console.log("[sendCommand] SignOn success but no refreshed state, fetching...");
                             fetchAndDisplayGameState(confirmedGameName);
                             stateToUpdateUI = null; // Prevent double update below
                             recommendationsToUpdateUI = null; // Prevent double update below
                         }
                    }
                }

                // If we have a refreshed state, update the sidebar
                if (stateToUpdateUI) {
                    console.log("[sendCommand] Updating UI sidebar with state:", stateToUpdateUI);
                    currentGameData = stateToUpdateUI; // Update global state variable
                    updateGameStateSidebar(currentGameData);
                }

                // If we have new recommendations (either from refresh or signon), update dropdown
                // *** MODIFIED: Use recommendationsToUpdateUI directly ***
                if (recommendationsToUpdateUI) {
                    console.log("[sendCommand] Updating command generator with new recommendations:", recommendationsToUpdateUI);
                    updateCommandGenerator(recommendationsToUpdateUI);
                } else if (stateToUpdateUI && !recommendationsToUpdateUI) {
                    // Fallback: If we got state but somehow no recommendations, fetch them
                    // This shouldn't happen with the server-side change, but good for safety
                    console.warn("[sendCommand] Refreshed state received, but no recommendations. Fetching separately.");
                    fetch(`/api/game/${stateToUpdateUI.name}`)
                       .then(res => res.json())
                       .then(data => {
                           if (data.success) {
                               updateCommandGenerator(data.recommendedCommands);
                           } else {
                                console.error("Fallback fetch for recommendations failed:", data.message);
                                updateCommandGenerator(null);
                           }
                       })
                       .catch(err => {
                            console.error("Error in fallback fetch for recommendations:", err);
                            updateCommandGenerator(null);
                       });
                }
                // --- End Update Logic ---

            } else { // result.success is false
                outputDiv.classList.remove('text-green-700', 'text-orange-700', 'text-blue-700');
                outputDiv.classList.add('text-red-700');
            }

        } catch (error) {
            console.error('Fetch Error:', error);
            outputDiv.textContent = `Client or Network Error: ${error.message}`;
            outputDiv.classList.remove('text-green-700', 'text-orange-700', 'text-blue-700');
            outputDiv.classList.add('text-red-700');
        } finally {
            sendButton.disabled = false;
            sendButton.textContent = 'Send Command';
            sendButton.classList.remove('opacity-50', 'cursor-not-allowed');
        }
    }


    // --- Text Area Enter Key Listener ---
    if (generatedCommandTextarea) {
        generatedCommandTextarea.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                sendCommand();
            }
        });
    }

    // --- Initial Load ---
    initializeDashboard();

}); // End DOMContentLoaded