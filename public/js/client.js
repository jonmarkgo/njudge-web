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


// --- Global UI Constants ---
const NJUDGE_INPUT_CLASS = 'input text-sm';
const NJUDGE_LABEL_CLASS = 'block text-sm font-medium text-gray-700 mb-1';
const NJUDGE_HELP_TEXT_CLASS = 'text-xs text-gray-500 mt-1';
const NJUDGE_CHECKBOX_CLASS = 'rounded border-gray-300 text-primary focus:ring-primary mr-2';
const NJUDGE_RADIO_CLASS = 'rounded-full border-gray-300 text-primary focus:ring-primary mr-1';

// --- User Preferences ---
const defaultPreferences = {
    sort_order: 'name_asc', // e.g., 'name_asc', 'name_desc', 'status_asc', 'status_desc'
    column_visibility: { // For game state sidebar elements
        status: true,
        phase: true,
        deadline: true,
        variant: true,
        masters: true,
        observers: true,
        players: true,
        settings: true,
        lastUpdated: true
    }
};
let userPreferences = JSON.parse(JSON.stringify(defaultPreferences)); // Deep copy defaults initially

// --- Make allGamesList and currentGameData globally accessible ---
window.allGamesList = [];
window.currentGameData = null;
let gameStatusChartInstance = null; // To hold the chart instance
let currentUserEmail = null; // Will be set on DOMContentLoaded

// --- UI Update Functions (Define these EARLIER) ---

function populateGameSelector(games) {
    const gameSelector = document.getElementById('game-selector');
    if (!gameSelector) return;
    const currentSelectedGame = gameSelector.value; // Preserve selection if possible
    gameSelector.innerHTML = '<option value="">-- Select Target Game --</option>'; // Default option

    // Apply sorting based on user preference
    const sortOrder = userPreferences.sort_order;
    games.sort((a, b) => {
        let compareA, compareB;
        switch (sortOrder) {
            case 'name_desc':
                compareA = b.name; compareB = a.name; break;
            case 'status_asc':
                compareA = a.status || 'Unknown'; compareB = b.status || 'Unknown'; break;
            case 'status_desc':
                compareA = b.status || 'Unknown'; compareB = a.status || 'Unknown'; break;
            case 'name_asc': // Default
            default:
                compareA = a.name; compareB = b.name; break;
        }
        // Ensure localeCompare is called on strings
        return String(compareA).localeCompare(String(compareB));
    });
    games.forEach(game => { // Sorting is done above now
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

function updateGameStateSidebar(gameState) {
    const gameStateSidebar = document.getElementById('game-state-sidebar');
    // Ensure preferences are loaded before using them
    const visibility = userPreferences?.column_visibility || defaultPreferences.column_visibility;
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
                else if (typeof value === 'object' && value !== null) displayValue = JSON.stringify(value); // Display Machiavelli transform object
                // Capitalize key
                const displayKey = key.charAt(0).toUpperCase() + key.slice(1);
                return `<li>${displayKey}: ${displayValue}</li>`;
            }).join('')}
        </ul>`
        : 'N/A';

    const lastUpdatedStr = gameState.lastUpdated ? new Date(gameState.lastUpdated * 1000).toLocaleString() : 'N/A';
    const observerLink = `https://www.floc.net/observer.py?partie=${gameState.name}`;

    // Build HTML conditionally based on visibility preferences
    let sidebarHtml = `<h2 class="text-xl font-semibold text-primary border-b border-gray-200 pb-3 mb-4">Game State: ${gameState.name}</h2><div class="space-y-2 text-sm">`;

    if (visibility.status) sidebarHtml += `<div><strong class="text-primary w-24 inline-block">Status:</strong> ${gameState.status || 'Unknown'}</div>`;
    if (visibility.phase) sidebarHtml += `<div><strong class="text-primary w-24 inline-block">Phase:</strong> ${gameState.currentPhase || 'Unknown'}</div>`;
    if (visibility.deadline) sidebarHtml += `<div><strong class="text-primary w-24 inline-block">Deadline:</strong> ${deadlineStr}</div>`;
    if (visibility.variant) sidebarHtml += `<div><strong class="text-primary w-24 inline-block">Variant:</strong> ${gameState.variant || 'Standard'} ${gameState.options && gameState.options.length > 0 ? `(${gameState.options.join(', ')})` : ''}</div>`;
    if (visibility.masters) sidebarHtml += `<div><strong class="text-primary w-24 inline-block">Masters:</strong> ${gameState.masters && gameState.masters.length > 0 ? gameState.masters.join(', ') : 'N/A'}</div>`;
    if (visibility.observers) sidebarHtml += `<div><strong class="text-primary w-24 inline-block">Observers:</strong> ${gameState.observers ? gameState.observers.length : 'N/A'}</div>`;

    if (visibility.players) {
        if (gameState.players && gameState.players.length > 0) {
            sidebarHtml += `
                <div class="pt-2 mt-2 border-t border-gray-200">
                    <strong class="text-primary block mb-1">Players (${gameState.players.length}):</strong>
                    ${playersHtml}
                </div>`;
        } else {
            sidebarHtml += '<div><strong class="text-primary w-24 inline-block">Players:</strong> N/A</div>';
        }
    }

    if (visibility.settings) {
         if (gameState.settings && Object.keys(gameState.settings).length > 0) {
            sidebarHtml += `
                <div class="pt-2 mt-2 border-t border-gray-200">
                    <strong class="text-primary block mb-1">Settings:</strong>
                    ${settingsHtml}
                </div>`;
         } else if (gameState.settings) { // Show N/A only if settings object exists but is empty
             sidebarHtml += '<div><strong class="text-primary w-24 inline-block">Settings:</strong> N/A</div>';
         }
    }

    sidebarHtml += `</div>`; // Close space-y-2 div

    if (visibility.lastUpdated) {
        sidebarHtml += `<p class="text-xs text-gray-500 mt-4">(State last updated: ${lastUpdatedStr})</p>`;
    }

    gameStateSidebar.innerHTML = sidebarHtml;
}

// --- Preference Application Logic ---
function applyPreferences() {
    console.log("Applying preferences:", userPreferences);
    // 1. Re-populate game selector based on sort order
    if (window.allGamesList && window.allGamesList.length > 0) { // Ensure game list is available
         populateGameSelector(window.allGamesList); // Defined above
    }
    // 2. Re-render game state sidebar based on column visibility
    if (window.currentGameData) { // Ensure current game data is available
        updateGameStateSidebar(window.currentGameData); // Defined above
    } else {
        // If no game is selected, ensure the sidebar reflects this, potentially clearing old state
         const gameStateSidebar = document.getElementById('game-state-sidebar');
         if (gameStateSidebar) {
             updateGameStateSidebar(null); // Call with null to show default message
         }
    }
    // Add other preference applications here if needed
}


// --- Preference Fetch/Save/Reset/Render (Keep these together) ---
async function fetchUserPreferences() {
    console.log("Fetching user preferences...");
    try {
        const response = await fetch('/api/user/preferences');
        if (!response.ok) {
            if (response.status === 404) { // No preferences saved yet is okay
                console.log("No existing user preferences found (404), using defaults. This is expected on first load."); // Clarify log
                userPreferences = JSON.parse(JSON.stringify(defaultPreferences));
            } else {
                // Throw error for other non-ok statuses
                const errorText = await response.text();
                throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
            }
        } else {
            const prefs = await response.json();
            if (prefs.success && prefs.preferences) {
                console.log("Fetched preferences:", prefs.preferences);
                // Merge fetched prefs with defaults to ensure all keys exist
                userPreferences = {
                    ...JSON.parse(JSON.stringify(defaultPreferences)), // Start with defaults
                    ...prefs.preferences, // Override with fetched values
                    column_visibility: { // Deep merge column visibility
                        ...defaultPreferences.column_visibility,
                        ...(prefs.preferences.column_visibility || {})
                    }
                };
            } else {
                 // Handle cases where success might be true but preferences are missing/null
                 console.warn("Fetched preferences response indicates success but preferences are missing or invalid:", prefs);
                 userPreferences = JSON.parse(JSON.stringify(defaultPreferences));
            }
        }
    } catch (error) {
        console.error('Error fetching user preferences:', error);
        // Fallback to defaults on any error (network, parsing, etc.)
        userPreferences = JSON.parse(JSON.stringify(defaultPreferences));
    }
    // Apply preferences after fetching (or falling back to defaults)
    applyPreferences(); // Moved after potential error handling
    // Render controls after preferences are loaded
    renderPreferenceControls();
}

async function saveUserPreferences() {
    console.log("Saving user preferences:", userPreferences);
    try {
        // Use PUT method to update preferences
        const response = await fetch('/api/user/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(userPreferences)
        });
        const result = await response.json();
        if (response.ok && result.success) {
            console.log("Preferences saved successfully.");
            alert("Preferences saved!");
            applyPreferences(); // Re-apply in case logic depends on it elsewhere
        } else {
            // Handle specific errors from the server
            const errorMsg = result.message || `HTTP error ${response.status}`;
            console.error("Failed to save preferences:", errorMsg);
            alert(`Error saving preferences: ${errorMsg}`);
        }
    } catch (error) {
        console.error('Network or parsing error saving user preferences:', error);
        alert(`Network error saving preferences: ${error.message}`);
    }
}

async function resetUserPreferences() {
    if (!confirm("Are you sure you want to reset your preferences to the defaults?")) {
        return;
    }
    console.log("Resetting user preferences...");
    try {
        const response = await fetch('/api/user/preferences/reset', { method: 'POST' });
        const result = await response.json();
        if (response.ok && result.success) {
            console.log("Preferences reset successfully.");
            alert("Preferences reset to default!");
            userPreferences = JSON.parse(JSON.stringify(defaultPreferences)); // Reset local state
            applyPreferences(); // Apply defaults
            renderPreferenceControls(); // Re-render controls with default values
        } else {
            const errorMsg = result.message || `HTTP error ${response.status}`;
            console.error("Failed to reset preferences:", errorMsg);
            alert(`Error resetting preferences: ${errorMsg}`);
        }
    } catch (error) {
        console.error('Network or parsing error resetting user preferences:', error);
        alert(`Network error resetting preferences: ${error.message}`);
    }
}

function renderPreferenceControls() {
    const controlsContainer = document.getElementById('preference-controls-container'); // Assuming this container exists in dashboard.ejs
    if (!controlsContainer) {
        console.warn("Preference controls container not found. Cannot render controls.");
        return;
    }

    // Clear previous controls
    controlsContainer.innerHTML = '';

    const form = document.createElement('form');
    form.className = 'space-y-4 p-4 border border-gray-200 rounded-md bg-gray-50';
    form.addEventListener('submit', (e) => e.preventDefault()); // Prevent default form submission

    // --- Sort Order ---
    const sortDiv = document.createElement('div');
    sortDiv.innerHTML = `<label for="pref-sort-order" class="block text-sm font-medium text-gray-700 mb-1">Game List Sort Order:</label>`;
    const sortSelect = document.createElement('select');
    sortSelect.id = 'pref-sort-order';
    sortSelect.className = NJUDGE_INPUT_CLASS;
    const sortOptions = [
        { value: 'name_asc', text: 'Name (A-Z)' },
        { value: 'name_desc', text: 'Name (Z-A)' },
        { value: 'status_asc', text: 'Status (A-Z)' },
        { value: 'status_desc', text: 'Status (Z-A)' }
        // Add more sort options if needed (e.g., by deadline)
    ];
    sortOptions.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.text;
        if (userPreferences.sort_order === opt.value) {
            option.selected = true;
        }
        sortSelect.appendChild(option);
    });
    sortSelect.addEventListener('change', (e) => {
        userPreferences.sort_order = e.target.value;
        // Optionally apply sort immediately or wait for save
        applyPreferences(); // Apply immediately to re-sort game list
    });
    sortDiv.appendChild(sortSelect);
    form.appendChild(sortDiv);

    // --- Column Visibility ---
    const visibilityDiv = document.createElement('div');
    visibilityDiv.innerHTML = `<label class="block text-sm font-medium text-gray-700 mb-2">Game State Visibility:</label>`;
    const gridDiv = document.createElement('div');
    gridDiv.className = 'grid grid-cols-2 gap-2'; // Simple grid layout

    Object.keys(defaultPreferences.column_visibility).forEach(key => {
        const checkboxDiv = document.createElement('div');
        checkboxDiv.className = 'flex items-center';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.id = `pref-vis-${key}`;
        checkbox.className = NJUDGE_CHECKBOX_CLASS;
        // Ensure userPreferences.column_visibility exists before accessing key
        checkbox.checked = userPreferences.column_visibility ? userPreferences.column_visibility[key] : defaultPreferences.column_visibility[key];
        checkbox.addEventListener('change', (e) => {
            // Ensure column_visibility object exists before setting property
            if (!userPreferences.column_visibility) {
                userPreferences.column_visibility = { ...defaultPreferences.column_visibility };
            }
            userPreferences.column_visibility[key] = e.target.checked;
             // Optionally apply visibility immediately or wait for save
             applyPreferences(); // Apply immediately to update sidebar
        });

        const label = document.createElement('label');
        label.htmlFor = checkbox.id;
        label.className = 'text-sm text-gray-700';
        // Capitalize key for display
        label.textContent = key.charAt(0).toUpperCase() + key.slice(1).replace(/([A-Z])/g, ' $1'); // Add space before caps

        checkboxDiv.appendChild(checkbox);
        checkboxDiv.appendChild(label);
        gridDiv.appendChild(checkboxDiv);
    });
    visibilityDiv.appendChild(gridDiv);
    form.appendChild(visibilityDiv);

    // --- Action Buttons ---
    const buttonDiv = document.createElement('div');
    buttonDiv.className = 'flex space-x-2 pt-3 border-t border-gray-200';

    const saveButton = document.createElement('button');
    saveButton.type = 'button'; // Important: prevent form submission
    saveButton.id = 'save-preferences-btn';
    saveButton.textContent = 'Save Preferences';
    saveButton.className = 'btn btn-primary';
    saveButton.addEventListener('click', saveUserPreferences);

    const resetButton = document.createElement('button');
    resetButton.type = 'button'; // Important: prevent form submission
    resetButton.id = 'reset-preferences-btn';
    resetButton.textContent = 'Reset to Default';
    resetButton.className = 'btn btn-secondary';
    resetButton.addEventListener('click', resetUserPreferences);

    buttonDiv.appendChild(saveButton);
    buttonDiv.appendChild(resetButton);
    form.appendChild(buttonDiv);

    controlsContainer.appendChild(form);
}


// --- Map Rendering (Updated for PNG) ---
async function renderMap(gameName, phase) {
    const mapContainer = document.getElementById('map-container');
    if (!mapContainer) {
        console.error("Map container element not found.");
        return;
    }

    // Clear previous content and show loading/default state
    mapContainer.innerHTML = '<p class="text-gray-500 italic p-4">Loading map image...</p>';

    if (!gameName) {
        mapContainer.innerHTML = '<p class="text-gray-500 italic p-4">Select a game and phase to view the map.</p>';
        return;
    }

    // Use phase if provided, otherwise the API defaults to latest
    const phaseParam = phase ? `/${encodeURIComponent(phase)}` : ''; // Ensure phase is encoded
    const apiUrl = `/api/map/${encodeURIComponent(gameName)}${phaseParam}`;
    console.log(`Fetching map URL from: ${apiUrl}`);

    try {
        const response = await fetch(apiUrl);
        // Check if response is OK, otherwise try to parse error JSON
        if (!response.ok) {
            let errorData = { message: `HTTP error ${response.status}` }; // Default error
            try {
                errorData = await response.json(); // Try parsing JSON error
            } catch (e) {
                console.warn("Could not parse error response as JSON.");
            }
            throw new Error(errorData.message || `HTTP error ${response.status}`);
        }

        const mapResult = await response.json();

        // Check if the backend indicated success and provided a mapUrl
        if (mapResult.success && mapResult.mapUrl) {
            console.log(`Received map URL: ${mapResult.mapUrl}`);
            // Create and display the image
            mapContainer.innerHTML = ''; // Clear loading message
            const img = document.createElement('img');
            img.src = mapResult.mapUrl;
            img.alt = `Map for ${gameName} - Phase ${phase || 'Latest'}`;
            img.className = 'w-full h-auto border border-gray-300'; // Add some basic styling
            // Optional: Add error handling for the image itself
            img.onerror = () => {
                 console.error(`Error loading map image from URL: ${mapResult.mapUrl}`);
                 mapContainer.innerHTML = `<p class="text-red-600 p-4">Error loading map image. The URL might be invalid or the image generation failed.</p>`;
            };
            mapContainer.appendChild(img);

        } else {
             // Handle cases where success might be false or mapUrl is missing
             throw new Error(mapResult.message || "Backend failed to provide a valid map URL.");
        }

    } catch (error) {
        console.error('Error fetching or displaying map image:', error);
        mapContainer.innerHTML = `<p class="text-red-600 p-4">Error loading map: ${error.message}</p>`;
    }
}
// --- End Map Rendering ---


function initializeTabSwitching() {
    const tabLinks = document.querySelectorAll('a[data-tab]');
    const primaryTabContent = document.getElementById('primary-tab-content');
    const secondaryTabContent = document.getElementById('secondary-tab-content');

    // If essential elements for tabbing aren't on this page, don't proceed.
    if (!primaryTabContent || !secondaryTabContent || tabLinks.length === 0) {
        // console.log('Dashboard Tab Switcher: Required elements not found. Tab functionality not initialized.');
        return;
    }

    function switchTab(targetTabName) {
        primaryTabContent.classList.add('hidden');
        secondaryTabContent.classList.add('hidden');

        const activeTabClasses = ['bg-white', 'text-primary', 'border-l', 'border-t', 'border-r'];
        const inactiveTabClasses = ['bg-gray-100', 'text-gray-600', 'hover:text-primary'];

        tabLinks.forEach(link => {
            const linkTabName = link.getAttribute('data-tab');
            link.classList.remove(...activeTabClasses);
            link.classList.remove(...inactiveTabClasses);

            if (linkTabName === targetTabName) {
                link.classList.add(...activeTabClasses);
            } else {
                link.classList.add(...inactiveTabClasses);
            }
        });

        if (targetTabName === 'primary') {
            primaryTabContent.classList.remove('hidden');
        } else if (targetTabName === 'secondary') {
            secondaryTabContent.classList.remove('hidden');
        } else {
            console.error('Dashboard Tab Switcher: Unknown targetTabName in switchTab:', targetTabName);
        }
    }

    tabLinks.forEach(tab => {
        tab.addEventListener('click', (event) => {
            event.preventDefault();
            const targetTabName = event.currentTarget.getAttribute('data-tab');
            if (targetTabName) {
                switchTab(targetTabName);
            } else {
                console.error('Dashboard Tab Switcher: Clicked tab has no data-tab attribute or its value is null/empty.');
            }
        });
    });

    // Initialize with the primary tab active by default.
    switchTab('primary');
    console.log('Dashboard tab switching initialized.'); // Confirmation log
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

    // --- Filter Elements ---
    const filterStatusSelect = document.getElementById('filter-status');
    const filterVariantInput = document.getElementById('filter-variant');
    const filterPlayerEmailInput = document.getElementById('filter-player-email');
    const filterPhaseInput = document.getElementById('filter-phase');
    const applyFiltersBtn = document.getElementById('apply-filters-btn');
    const clearFiltersBtn = document.getElementById('clear-filters-btn'); // Added

    // --- Bookmark Elements ---
    const savedSearchSelect = document.getElementById('saved-search-select');
    const applyBookmarkBtn = document.getElementById('apply-bookmark-btn');
    const deleteBookmarkBtn = document.getElementById('delete-bookmark-btn');
    const newBookmarkNameInput = document.getElementById('new-bookmark-name');
    const saveBookmarkBtn = document.getElementById('save-bookmark-btn');

    // --- News Elements ---
    const newsSection = document.getElementById('news-section');
    const addNewsForm = document.getElementById('add-news-form');
    const newsContentInput = document.getElementById('news-content');
    const addNewsFeedback = document.getElementById('add-news-feedback');
    const newsErrorDiv = document.getElementById('news-error');
    const newsSectionContainer = document.getElementById('news-section-container');

    // --- Game Management Elements ---
    const addGameForm = document.getElementById('add-game-form');
    const addGameNameInput = document.getElementById('add-game-name');
    const addGameVariantInput = document.getElementById('add-game-variant');
    const addGamePasswordInput = document.getElementById('add-game-password');
    const removeGameBtn = document.getElementById('remove-game-btn');
    const removeGamePasswordInput = document.getElementById('remove-game-password');
    const gameManagementFeedbackDiv = document.getElementById('game-management-feedback');

    // --- Chart Elements ---
    const canvasElement = document.getElementById('gameStatusChart');
    const chartErrorElement = document.getElementById('chart-error');

    // --- State Variables ---
    // window.currentGameData = null; // Defined globally now
    // window.allGamesList = []; // Defined globally now
    currentUserEmail = userEmailIndicator ? userEmailIndicator.dataset.email : null; // Set global variable
    window.currentUserEmail = currentUserEmail; // Also store globally for easy check
    let currentFilters = {}; // Store the currently applied filters
    let savedBookmarks = []; // Store fetched bookmarks
    let currentGeneratedCommand = '';

    // --- Command Option Helper Functions (Moved to broader scope) ---
    // Helper function to query selector safely within optionsArea
    const qs = (selector) => optionsArea?.querySelector(selector); // Add check for optionsArea
    const qsa = (selector) => optionsArea?.querySelectorAll(selector); // Add check for optionsArea

    // Helper to get trimmed value from input, or default
    const val = (selector, defaultValue = '') => qs(selector)?.value.trim() || defaultValue;
    // Helper to get raw value (no trim, for passwords etc.)
    const rawVal = (selector, defaultValue = '') => qs(selector)?.value || defaultValue;
    // Helper to check if a checkbox is checked
    const checked = (selector) => qs(selector)?.checked || false;

    // Helper to get value of selected radio button
    const radioVal = (name, defaultValue = '') => qs(`input[name="${name}"]:checked`)?.value || defaultValue;

    // Helper to create form elements
    const createInput = (id, type, label, placeholder = '', required = false, value = '', help = '', otherAttrs = {}) => {
        let attrsString = '';
        for (const [key, val] of Object.entries(otherAttrs)) {
            attrsString += ` ${key}="${String(val).replace(/"/g, '&amp;quot;')}"`; // Escape quotes in attributes
        }
        return `
            <div class="my-2">
                <label for="${id}" class="${NJUDGE_LABEL_CLASS}">${label}${required ? '<span class="text-red-500">*</span>' : ''}</label>
                <input type="${type}" id="${id}" name="${id}" class="${NJUDGE_INPUT_CLASS}" placeholder="${placeholder}" ${required ? 'required' : ''} value="${String(value).replace(/"/g, '&quot;')}" ${attrsString}>
                ${help ? `<p class="${NJUDGE_HELP_TEXT_CLASS}">${help}</p>` : ''}
            </div>`;
    };
    const createTextarea = (id, label, placeholder = '', required = false, rows = 3, help = '') => {
         return `
            <div class="my-2">
                <label for="${id}" class="${NJUDGE_LABEL_CLASS}">${label}${required ? '<span class="text-red-500">*</span>' : ''}</label>
                <textarea id="${id}" name="${id}" class="${NJUDGE_INPUT_CLASS} font-mono min-h-[${rows * 1.5}rem] resize-y" placeholder="${placeholder}" ${required ? 'required' : ''} rows="${rows}"></textarea>
                ${help ? `<p class="${NJUDGE_HELP_TEXT_CLASS}">${help}</p>` : ''}
            </div>`;
    };
    const createSelect = (id, label, options, required = false, help = '', multiple = false, size = 1) => {
        const optionsHtml = options.map(opt => `<option value="${opt.value}" ${opt.selected ? 'selected' : ''} ${opt.disabled ? 'disabled' : ''}>${opt.text}</option>`).join('');
        return `
            <div class="my-2">
                <label for="${id}" class="${NJUDGE_LABEL_CLASS}">${label}${required ? '<span class="text-red-500">*</span>' : ''}</label>
                <select id="${id}" name="${id}" class="${NJUDGE_INPUT_CLASS}" ${required ? 'required' : ''} ${multiple ? 'multiple' : ''} size="${multiple ? Math.max(size, options.length, 3) : 1}">${optionsHtml}</select>
                ${help ? `<p class="${NJUDGE_HELP_TEXT_CLASS}">${help}</p>` : ''}
            </div>`;
    };
     const createCheckbox = (id, label, checked = false, help = '', value = 'true', name = id) => {
         return `
            <div class="flex items-center my-1">
                <input type="checkbox" id="${id}" name="${name}" class="${NJUDGE_CHECKBOX_CLASS}" ${checked ? 'checked' : ''} value="${value}">
                <label for="${id}" class="ml-1 text-sm font-medium text-gray-700">${label}</label>
                ${help ? `<p class="${NJUDGE_HELP_TEXT_CLASS} ml-1">${help}</p>` : ''}
            </div>`;
     };
     const createRadio = (id, name, label, checked = false, help = '', value = id) => { // Added value param
         return `
            <div class="flex items-center my-1">
                <input type="radio" id="${id}" name="${name}" class="${NJUDGE_RADIO_CLASS}" ${checked ? 'checked' : ''} value="${value}">
                <label for="${id}" class="ml-1 text-sm font-medium text-gray-700">${label}</label>
                ${help ? `<p class="${NJUDGE_HELP_TEXT_CLASS} ml-1">${help}</p>` : ''}
            </div>`;
     };
     const createPowerCheckboxes = (idPrefix, gameData, includeMaster = true, includeObservers = true) => {
         let checkboxesHtml = `<div class="grid grid-cols-2 gap-x-2 gap-y-1 border p-2 rounded bg-gray-50">`;
         if (gameData?.players) {
             gameData.players.sort((a, b) => (a.power || '').localeCompare(b.power || '')).forEach(p => {
                 const initial = p.power?.charAt(0).toUpperCase();
                 if (initial) {
                     checkboxesHtml += createCheckbox(`${idPrefix}-${initial}`, `${p.power} (${initial})`, false, '', initial, `${idPrefix}-power`);
                 }
             });
         }
         if (includeMaster) checkboxesHtml += createCheckbox(`${idPrefix}-M`, `Master (M)`, false, '', 'M', `${idPrefix}-power`);
         if (includeObservers) checkboxesHtml += createCheckbox(`${idPrefix}-O`, `Observers (O)`, false, '', 'O', `${idPrefix}-power`);
         checkboxesHtml += `</div>`;
         return checkboxesHtml;
     };
     const createSeparator = () => '<hr class="my-3 border-gray-200">';
     const createInfo = (text) => `<p class="text-sm text-gray-600 my-1">${text}</p>`;
     const createWarning = (text) => `<p class="text-sm text-orange-600 my-1">${text}</p>`;
     const createError = (text) => `<p class="text-sm text-red-600 my-1">${text}</p>`;

    // --- End Command Option Helper Functions ---

    // --- Initial Setup ---
    async function initializeDashboard() { // Make async for await fetchUserPreferences
        initializeTabSwitching(); // Initialize tab switching for the dashboard
        // Fetch preferences first if logged in
        if (window.currentUserEmail) {
            await fetchUserPreferences(); // Wait for prefs before fetching games
        } else {
            // Not logged in, apply defaults and render controls (which will be empty/disabled)
            applyPreferences();
            renderPreferenceControls();
        }

        // Fetch all games using the new function (initially with no filters)
        fetchAndPopulateGames();

        // Fetch bookmarks if logged in
        if (window.currentUserEmail) {
            fetchAndPopulateBookmarks();
        }

        // Add event listeners for filters and bookmarks (check if elements exist)
        if (applyFiltersBtn) {
            applyFiltersBtn.addEventListener('click', () => {
                currentFilters = getCurrentFilterValues();
                fetchAndPopulateGames(currentFilters);
            });
        }
        if (clearFiltersBtn) {
            clearFiltersBtn.addEventListener('click', clearFiltersAndRefetch);
        }
        if (applyBookmarkBtn) {
            applyBookmarkBtn.addEventListener('click', applyBookmark);
        }
        if (saveBookmarkBtn) {
            saveBookmarkBtn.addEventListener('click', saveBookmark);
        }
        if (deleteBookmarkBtn) {
            deleteBookmarkBtn.addEventListener('click', deleteBookmark);
        }

        // Fetch and render the game status chart if canvas exists
        if (canvasElement) {
            fetchAndRenderGameStatusChart();
        }

        // Fetch news if container exists
        if (newsSectionContainer) {
            fetchAndDisplayNews();
        }

        // Initial map state (placeholder)
        renderMap(null);
    }

    // --- New Function: Fetch Games with Filters ---
    function fetchAndPopulateGames(filterParams = {}) {
        console.log("Fetching games with filters:", filterParams);
        const queryParams = new URLSearchParams();
        Object.entries(filterParams).forEach(([key, value]) => {
            if (value) { // Only add non-empty filters
                queryParams.append(key, value);
            }
        });
        const queryString = queryParams.toString();
        const fetchUrl = `/api/games${queryString ? '?' + queryString : ''}`;

        // Show loading state? (Optional)
        if (gameSelector) gameSelector.innerHTML = '<option value="">Loading games...</option>';

        fetch(fetchUrl)
            .then(response => {
                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success && data.games) {
                    window.allGamesList = data.games; // Store globally
                    applyPreferences(); // This will call populateGameSelector which uses window.allGamesList

                    // Re-select initial/cookie game if it exists in the filtered list
                    const initialGame = getCookie('targetGame');
                    const gameExistsInList = window.allGamesList.some(g => g.name === initialGame);

                    if (initialGame && gameSelector && gameExistsInList) {
                        gameSelector.value = initialGame;
                        if (targetGameInput) targetGameInput.value = initialGame;
                        console.log("Restored game selection after filter:", initialGame);
                        // Fetch state only if the game is still selected and visible
                        if (gameSelector.value === initialGame) {
                             fetchAndDisplayGameState(initialGame);
                        } else {
                             // Game was selected but isn't in the filtered list anymore
                             fetchAndDisplayGameState(null); // Clear state
                        }
                    } else if (window.allGamesList.length > 0) {
                         // If no specific game selected or cookie game filtered out, but list isn't empty
                         // Select the first game in the list? Or just clear state? Clear for now.
                         fetchAndDisplayGameState(null);
                         console.log("Initial game not found in filtered list or no initial game.");
                    } else {
                        // No games found with these filters
                        updateGameStateSidebar(null); // Show empty state
                        updateCommandGenerator(null); // Show default recommendations
                        loadCredentialsForGame(null); // Ensure clear if no initial game
                        renderMap(null); // Clear map
                        console.log("No games found matching filters.");
                        if (gameSelector) gameSelector.innerHTML = '<option value="">No games match filters</option>';
                    }
                } else {
                    // Handle cases where success might be false from backend
                    const errorMsg = data.message || "Failed to fetch filtered game list (unknown reason).";
                    console.error("Failed to fetch filtered game list:", errorMsg);
                    updateGameStateSidebar(null); // Show empty state on error
                    updateCommandGenerator(null);
                    renderMap(null); // Clear map
                    if (gameSelector) gameSelector.innerHTML = '<option value="">Error loading games</option>';
                }
            })
            .catch(error => {
                console.error('Error fetching filtered game list:', error);
                updateGameStateSidebar(null);
                updateCommandGenerator(null);
                renderMap(null); // Clear map
                if (gameSelector) gameSelector.innerHTML = '<option value="">Error loading games</option>';
            });
    }

    // --- Helper: Get Current Filter Values ---
    function getCurrentFilterValues() {
        const filters = {};
        if (filterStatusSelect && filterStatusSelect.value) filters.status = filterStatusSelect.value;
        if (filterVariantInput && filterVariantInput.value.trim()) filters.variant = filterVariantInput.value.trim();
        if (filterPlayerEmailInput && filterPlayerEmailInput.value.trim()) filters.player = filterPlayerEmailInput.value.trim(); // 'player' is the backend param
        if (filterPhaseInput && filterPhaseInput.value.trim()) filters.phase = filterPhaseInput.value.trim();
        return filters;
    }

    // --- Helper: Clear Filters ---
    function clearFiltersAndRefetch() {
        if (filterStatusSelect) filterStatusSelect.value = '';
        if (filterVariantInput) filterVariantInput.value = '';
        if (filterPlayerEmailInput) filterPlayerEmailInput.value = '';
        if (filterPhaseInput) filterPhaseInput.value = '';
        currentFilters = {}; // Reset stored filters
        fetchAndPopulateGames(); // Fetch all games
    }

    // --- Bookmark Functions ---
    async function fetchAndPopulateBookmarks() { // Make async
        if (!savedSearchSelect || !window.currentUserEmail) return; // Need select & user
        console.log("Fetching bookmarks...");
        savedSearchSelect.innerHTML = '<option value="">Loading...</option>'; // Loading indicator

        try {
            const response = await fetch('/api/user/search-bookmarks');
            if (!response.ok) {
                 if (response.status === 404) { // No bookmarks saved yet is okay
                     console.log("No saved bookmarks found.");
                     savedBookmarks = [];
                 } else {
                     const errorText = await response.text();
                     throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
                 }
            } else {
                const result = await response.json();
                if (result.success && Array.isArray(result.bookmarks)) {
                    savedBookmarks = result.bookmarks;
                    console.log("Fetched bookmarks:", savedBookmarks);
                } else {
                    console.error("Failed to fetch bookmarks or invalid format:", result);
                    savedBookmarks = [];
                    alert("Error loading bookmarks. Check console.");
                }
            }
        } catch (error) {
            console.error('Error fetching bookmarks:', error);
            savedBookmarks = [];
            alert(`Network error loading bookmarks: ${error.message}`);
            savedSearchSelect.innerHTML = '<option value="">Error loading</option>'; // Error indicator
        }
        populateBookmarkSelect(); // Call this after fetch completes (success or error with empty list)
    }

    function populateBookmarkSelect() {
        if (!savedSearchSelect) return;
        savedSearchSelect.innerHTML = '<option value="">-- Select Bookmark --</option>';
        savedBookmarks.forEach(bm => {
            const option = document.createElement('option');
            option.value = bm.name;
            // Display params concisely in the option text (optional)
            const paramsDesc = Object.entries(bm.params)
                                   .map(([k, v]) => `${k}:${v}`)
                                   .join(', ');
            option.textContent = `${bm.name} (${paramsDesc || 'No filters'})`;
            savedSearchSelect.appendChild(option);
        });
    }

    function applyBookmark() {
        if (!savedSearchSelect || !savedSearchSelect.value) return;
        const selectedName = savedSearchSelect.value;
        const bookmark = savedBookmarks.find(bm => bm.name === selectedName);
        if (!bookmark) {
            console.error("Selected bookmark not found:", selectedName);
            alert("Error: Could not find selected bookmark.");
            return;
        }
        console.log("Applying bookmark:", bookmark.name, bookmark.params);

        // Update filter UI elements
        if (filterStatusSelect) filterStatusSelect.value = bookmark.params.status || '';
        if (filterVariantInput) filterVariantInput.value = bookmark.params.variant || '';
        if (filterPlayerEmailInput) filterPlayerEmailInput.value = bookmark.params.player || '';
        if (filterPhaseInput) filterPhaseInput.value = bookmark.params.phase || '';

        // Apply the filters by fetching games
        currentFilters = bookmark.params; // Store applied filters
        fetchAndPopulateGames(currentFilters);
    }

    async function saveBookmark() { // Make async
        if (!newBookmarkNameInput || !newBookmarkNameInput.value.trim()) {
            alert("Please enter a name for the bookmark.");
            return;
        }
        const name = newBookmarkNameInput.value.trim();
        const params = getCurrentFilterValues();

        if (Object.keys(params).length === 0) {
            alert("Cannot save a bookmark with no filters set.");
            return;
        }

        // Check if name already exists
        if (savedBookmarks.some(bm => bm.name.toLowerCase() === name.toLowerCase())) {
            if (!confirm(`A bookmark named "${name}" already exists. Overwrite it?`)) {
                return;
            }
            // Note: The backend currently doesn't support direct overwrite via POST,
            // it might return an error. Ideally, the backend would handle upsert
            // or we'd need a PUT/PATCH endpoint. For now, we proceed and let the
            // backend handle potential conflicts (or we could delete first).
            // Let's assume the backend handles it or returns a useful error.
        }

        console.log("Saving bookmark:", name, params);
        const bookmarkData = { name, params };

        try {
            const response = await fetch('/api/user/search-bookmarks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(bookmarkData)
            });
            const result = await response.json();
            if (response.ok && result.success) {
                console.log("Bookmark saved successfully.");
                alert(`Bookmark "${name}" saved!`);
                newBookmarkNameInput.value = ''; // Clear input
                fetchAndPopulateBookmarks(); // Refresh the list
            } else {
                const errorMsg = result.message || `HTTP error ${response.status}`;
                console.error("Failed to save bookmark:", errorMsg);
                alert(`Error saving bookmark: ${errorMsg}`);
            }
        } catch (error) {
            console.error('Network or parsing error saving bookmark:', error);
            alert(`Network error saving bookmark: ${error.message}`);
        }
    }

    async function deleteBookmark() { // Make async
        if (!savedSearchSelect || !savedSearchSelect.value) {
            alert("Please select a bookmark to delete.");
            return;
        }
        const name = savedSearchSelect.value;
        if (!confirm(`Are you sure you want to delete the bookmark "${name}"?`)) {
            return;
        }

        console.log("Deleting bookmark:", name);
        // URL encode the name in case it contains special characters
        const encodedName = encodeURIComponent(name);

        try {
            const response = await fetch(`/api/user/search-bookmarks/${encodedName}`, {
                method: 'DELETE'
            });
            const result = await response.json(); // Even DELETE might return JSON
            if (response.ok && result.success) {
                console.log("Bookmark deleted successfully.");
                alert(`Bookmark "${name}" deleted.`);
                fetchAndPopulateBookmarks(); // Refresh the list
            } else {
                 // Handle cases where deletion might fail (e.g., not found, permissions)
                 const errorMsg = result.message || `HTTP error ${response.status}`;
                 console.error("Failed to delete bookmark:", errorMsg);
                 alert(`Error deleting bookmark: ${errorMsg}`);
            }
        } catch (error) {
             console.error('Network or parsing error deleting bookmark:', error);
             alert(`Network error deleting bookmark: ${error.message}`);
        }
    }

    // --- Game Status Chart Functions ---
    async function fetchAndRenderGameStatusChart() {
        if (typeof Chart === 'undefined') {
          console.error('CRITICAL: Chart object is undefined when fetchAndRenderGameStatusChart() is called. Chart.js might not be loaded or initialized yet.');
          // Optionally, you could try delaying and retrying, but for now, just log and exit.
          return;
        }

        // Ensure elements exist
        if (!canvasElement) {
            console.warn('Game status chart canvas element not found.');
            return;
        }
        if (chartErrorElement) chartErrorElement.textContent = ''; // Clear previous errors

        // Check if Chart.js library is loaded
        if (typeof Chart === 'undefined') {
            const errorMsg = 'Chart.js library not loaded. Cannot render chart.';
            console.error(errorMsg);
            if (chartErrorElement) chartErrorElement.textContent = errorMsg;
            return;
        }

        try {
            console.log('Fetching game status stats...');
            const response = await fetch('/api/stats/game-status');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const result = await response.json();

            if (result.success && Array.isArray(result.stats)) {
                console.log('Game status stats received:', result.stats);
                const labels = result.stats.map(item => item.status);
                const data = result.stats.map(item => item.count);

                const ctx = canvasElement.getContext('2d');

                // Destroy previous chart instance if it exists
                if (gameStatusChartInstance) {
                    console.log('Destroying previous game status chart instance.');
                    gameStatusChartInstance.destroy();
                }

                // Define some colors (can be expanded or customized)
                const backgroundColors = [
                    'rgba(54, 162, 235, 0.7)', // Blue
                    'rgba(75, 192, 192, 0.7)', // Green
                    'rgba(255, 206, 86, 0.7)', // Yellow
                    'rgba(153, 102, 255, 0.7)', // Purple
                    'rgba(255, 99, 132, 0.7)',  // Red
                    'rgba(255, 159, 64, 0.7)',  // Orange
                    'rgba(201, 203, 207, 0.7)'  // Grey
                ];
                const borderColors = backgroundColors.map(color => color.replace('0.7', '1')); // Make borders solid

                console.log('Rendering game status chart...');
                gameStatusChartInstance = new Chart(ctx, {
                    type: 'pie', // Or 'bar', 'doughnut'
                    data: {
                        labels: labels,
                        datasets: [{
                            label: 'Game Count by Status',
                            data: data,
                            backgroundColor: backgroundColors.slice(0, data.length), // Use defined colors
                            borderColor: borderColors.slice(0, data.length),
                            borderWidth: 1
                        }]
                    },
                    options: {
                        responsive: true,
                        plugins: {
                            legend: {
                                position: 'top',
                            },
                            title: {
                                display: true,
                                text: 'Game Status Distribution'
                            }
                        }
                    }
                });
            } else if (result.success && result.stats.length === 0) {
                 console.log('No game status data to display.');
                 if (chartErrorElement) chartErrorElement.textContent = 'No game status data available.';
                 // Optionally destroy old chart if data becomes empty
                 if (gameStatusChartInstance) {
                    gameStatusChartInstance.destroy();
                    gameStatusChartInstance = null;
                 }
            } else {
                throw new Error(result.message || 'Failed to fetch or parse game status stats.');
            }
        } catch (error) {
            console.error('Error fetching or rendering game status chart:', error);
            if (chartErrorElement) {
                chartErrorElement.textContent = `Error loading chart: ${error.message}`;
            }
             // Optionally destroy old chart on error
             if (gameStatusChartInstance) {
                gameStatusChartInstance.destroy();
                gameStatusChartInstance = null;
             }
        }
    }



    // --- Game Selection Change Handler ---
    if (gameSelector) {
        gameSelector.addEventListener('change', (e) => {
            const selectedGame = e.target.value;
            fetchAndDisplayGameState(selectedGame);
        });
    }

    // --- Command Type Change Handler ---
    if (commandTypeSelect) {
        commandTypeSelect.addEventListener('change', (e) => {
            const selectedCommand = e.target.value;
            // Pass current game state to the generator
            generateCommandOptions(selectedCommand, window.currentGameData);
            updateGeneratedCommandText(window.currentGameData); // This will now update currentGeneratedCommand
        });
    }

    // --- Send Command Button Handler ---
    if (sendButton) {
        sendButton.addEventListener('click', () => sendCommand());
    }

    // --- Textarea Enter Key Handler ---
    if (generatedCommandTextarea) {
        generatedCommandTextarea.addEventListener('keypress', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { // Send on Enter, allow newline with Shift+Enter
                e.preventDefault(); // Prevent default Enter behavior (newline)
                sendCommand();
            }
        });
        // Update command text on any input change in the textarea itself
        generatedCommandTextarea.addEventListener('input', () => updateGeneratedCommandText(window.currentGameData));
    }

    // --- Refresh State Button ---
    if (refreshStateButton) {
        refreshStateButton.addEventListener('click', () => {
            const selectedGame = targetGameInput?.value;
            if (selectedGame) {
                fetchAndDisplayGameState(selectedGame);
                // Optionally show a small visual confirmation
                 refreshStateButton.textContent = 'Refreshing...';
                 setTimeout(() => { refreshStateButton.textContent = 'Refresh State'; }, 1500);
            } else {
                alert("Please select a game first.");
            }
        });
    }

    // --- Clear Credentials Button ---
    if (clearCredentialsButton) {
        clearCredentialsButton.addEventListener('click', () => {
             if (confirm("Are you sure you want to clear the selected target game and its stored password/variant?")) {
                if (gameSelector) gameSelector.value = ''; // Reset dropdown
                if (targetGameInput) targetGameInput.value = ''; // Clear hidden input
                if (targetPasswordInput) targetPasswordInput.value = ''; // Clear password field
                if (targetVariantInput) targetVariantInput.value = ''; // Clear variant field
                eraseCookie('targetGame'); // Erase game cookie
                clearAllCredentials(); // Clear stored credentials from local storage
                fetchAndDisplayGameState(null); // Clear the game state sidebar and command generator
                alert("Target game and credentials cleared.");
             }
        });
    }

    // --- Password/Variant Input Handling ---
    if (targetPasswordInput) {
        targetPasswordInput.addEventListener('input', saveCredentialsForGame); // Save on input
    }
    if (targetVariantInput) {
        targetVariantInput.addEventListener('input', saveCredentialsForGame); // Save on input
    }

    // --- Game State Handling ---
    function fetchAndDisplayGameState(gameName) {
        if (!gameName) {
            window.currentGameData = null; // Store globally
            updateGameStateSidebar(null);
            updateCommandGenerator(null); // Update recommendations for "no game" context
            if (targetGameInput) targetGameInput.value = '';
            loadCredentialsForGame(null); // Clear credentials fields
            renderMap(null); // Clear map
            return;
        }

        console.log("Fetching state for:", gameName);
        if (gameStateSidebar) gameStateSidebar.innerHTML = '<p class="text-gray-500 italic">Loading game state...</p>'; // Loading indicator

        fetch(`/api/game/${gameName}`)
            .then(response => {
                if (!response.ok) {
                    // Handle 404 specifically
                    if (response.status === 404) {
                         throw new Error(`Game '${gameName}' not found.`);
                    }
                    throw new Error(`HTTP error! status: ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                if (data.success) {
                    console.log("[fetchAndDisplayGameState] Received game state and recommendations:", data);
                    window.currentGameData = data.gameState; // Store globally
                    updateGameStateSidebar(currentGameData);
                    updateCommandGenerator(data.recommendedCommands); // Update commands based on fetched state
                    if (targetGameInput) targetGameInput.value = gameName; // Update hidden input
                    setCookie('targetGame', gameName, 30); // Update cookie
                    renderMap(gameName, data.gameState.currentPhase); // Render the map

                    loadCredentialsForGame(gameName); // Load credentials for this game
                } else {
                    // Handle backend success=false
                    const errorMsg = data.message || `Failed to fetch game state for ${gameName} (unknown reason).`;
                    console.error(`Failed to fetch game state for ${gameName}:`, errorMsg);
                    if (gameStateSidebar) gameStateSidebar.innerHTML = `<p class="text-red-600">Error loading state for ${gameName}: ${errorMsg}</p>`;
                    window.currentGameData = null; // Store globally
                    updateCommandGenerator(null); // Reset recommendations
                    renderMap(null); // Clear map
                    loadCredentialsForGame(gameName); // Still try to load credentials
                }
            })
            .catch(error => {
                console.error(`Error fetching game state for ${gameName}:`, error);
                if (gameStateSidebar) gameStateSidebar.innerHTML = `<p class="text-red-600">Network or server error loading state for ${gameName}: ${error.message}</p>`;
                window.currentGameData = null; // Store globally
                updateCommandGenerator(null);
                renderMap(null); // Clear map
                loadCredentialsForGame(gameName);
            });
    }

    // --- Credential Handling (Password + Variant) ---
    function saveCredentialsForGame() {
        const gameName = targetGameInput?.value; // Check if element exists
        const password = targetPasswordInput?.value;
        const variant = targetVariantInput?.value; // Get variant value

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
        if (targetPasswordInput && targetVariantInput) { // Check elements exist
            if (gameName) {
                targetPasswordInput.value = getCookie(`targetPassword_${gameName}`) || '';
                targetVariantInput.value = getCookie(`targetVariant_${gameName}`) || ''; // Set variant input
            } else {
                targetPasswordInput.value = ''; // Clear if no game selected
                targetVariantInput.value = ''; // Clear variant input too
            }
        }
    }

    function clearAllCredentials() {
         if (confirm('Are you sure you want to clear the stored password and variant for the current game and remove the target game selection?')) {
             const gameName = targetGameInput?.value;
             if (gameName) {
                 eraseCookie(`targetPassword_${gameName}`);
                 eraseCookie(`targetVariant_${gameName}`); // Erase variant cookie
             }
             eraseCookie('targetGame');
             if (targetGameInput) targetGameInput.value = '';
             if (targetPasswordInput) targetPasswordInput.value = '';
             if (targetVariantInput) targetVariantInput.value = ''; // Clear variant input
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
             recommended: [], gameInfo: ['LIST'], playerActions: [], settings: [], general: ['HELP', 'VERSION', 'MANUAL'], master: [], machiavelli: []
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
        if (commands.machiavelli && commands.machiavelli.length > 0) { // Add Machiavelli group if present
            addOptGroup('Machiavelli Actions', commands.machiavelli);
        }
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
             if (optionsArea) optionsArea.innerHTML = '<p class="text-sm text-gray-500 italic">Select an action above to see options.</p>';
             if (generatedCommandTextarea && generatedCommandTextarea.readOnly) {
                 generatedCommandTextarea.value = '';
                 generatedCommandTextarea.placeholder = "Select action or type command manually. Do NOT include SIGN OFF.";
             }
             currentGeneratedCommand = ''; // Clear the stored command when no command type is selected
        }
    }

    // --- generateCommandOptions: Expanded significantly ---
    // Pass gameData to this function
    function generateCommandOptions(selectedCommand, gameData) {
        if (!optionsArea || !generatedCommandTextarea) return; // Ensure elements exist

        optionsArea.innerHTML = ''; // Clear previous options
        if (generatedCommandTextarea.readOnly) {
            generatedCommandTextarea.value = ''; // Clear textarea
            generatedCommandTextarea.placeholder = "Configure options above or type command here directly. Do NOT include SIGN OFF."; // Reset placeholder
        }
        currentGeneratedCommand = ''; // Always clear the stored command when options change

        const targetGame = targetGameInput?.value || '<game>'; // Use selected game or placeholder
        const powerInitials = gameData?.players?.map(p => p.power?.charAt(0).toUpperCase()).filter(Boolean) || [];
        const myPlayerInfo = gameData?.players?.find(p => p.email === currentUserEmail);
        const myPowerInitial = myPlayerInfo?.power?.charAt(0).toUpperCase();
        const myUnits = myPlayerInfo?.units || [];
        const isMachiavelliGame = gameData?.settings?.isMachiavelli || gameData?.variant?.toLowerCase().includes('machiavelli');
        const currentPhaseType = gameData?.currentPhase?.slice(-1).toUpperCase(); // M, R, A/B

        // Helper to create form elements (using NJUDGE_ prefixed constants)
        // createInput, createTextarea, createSelect, createCheckbox, createRadio, createPowerCheckboxes, createSeparator, createInfo, createWarning, createError
        // These are already defined above in the global scope of DOMContentLoaded

        let content = '<div class="space-y-1">'; // Use tighter spacing for options

        // --- Add cases based on commands available in njudgedocs.txt ---
        switch (selectedCommand) {
            // --- General / Info ---
            case 'GET':
                content += createSelect('get-filename', 'Filename', [
                    {value: '', text: '-- Select File --'},
                    {value: 'info', text: 'info (General Help)'},
                    {value: 'guide', text: 'guide (Newbie Guide)'},
                    {value: 'index', text: 'index (Command Index)'},
                    {value: 'syntax', text: 'syntax (Order Syntax)'},
                    {value: 'deadlines', text: 'deadlines'},
                    {value: 'rules', text: 'rules (Standard)'},
                    {value: 'house.rules', text: 'house.rules'},
                    {value: 'press', text: 'press'},
                    {value: 'map', text: 'map (Standard Adjacencies)'},
                    {value: 'form', text: 'form (Registration)'},
                    {value: 'flist', text: 'flist (Full File List)'},
                    // Add common variant info files if desired
                    {value: 'info.gunboat', text: 'info.gunboat'},
                    {value: 'info.chaos', text: 'info.chaos'},
                    {value: 'info.machiavelli', text: 'info.machiavelli'},
                    {value: 'rules.machiavelli', text: 'rules.machiavelli'},
                    {value: 'map.machiavelli', text: 'map.machiavelli'},
                ], true);
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
                content += createInput('hist-game-name', 'text', 'Game Name', 'Game Name', true, targetGame !== '<game>' ? targetGame : '');
                content += createSeparator();
                content += createInfo('Retrieve by Date Range:');
                content += createInput('hist-from', 'text', 'From Date (optional)', 'e.g., Jan 1 2023 or S1901M', false, '', 'Defaults to 1 week ago.');
                content += createInput('hist-to', 'text', 'To Date (optional)', 'e.g., Dec 31 2023 or F1905B', false, '', 'Defaults to now.');
                content += createInput('hist-lines', 'number', 'Max Lines (optional)', 'e.g., 5000', false, '', 'Defaults to 1000.');
                content += createSeparator();
                content += createInfo('OR Exclude Turn Range:');
                content += createInput('hist-exclstart', 'text', 'EXCLSTART turnId', 'e.g., S1903M', false, '', 'Start of range to exclude.');
                content += createInput('hist-exclend', 'text', 'EXCLEND turnId', 'e.g., F1905B', false, '', 'End of range to exclude (optional).');
                content += createCheckbox('hist-broad', 'Include Broadcasts (with EXCL)?', false);
                break;
            case 'SUMMARY':
                content += createInput('summary-game-name', 'text', 'Game Name', 'Game Name', true, targetGame !== '<game>' ? targetGame : '');
                break;
            case 'WHOGAME':
                content += createInput('whogame-game-name', 'text', 'Game Name', 'Game Name', true, targetGame !== '<game>' ? targetGame : '');
                content += createCheckbox('whogame-full', 'Include Observers (FULL)?', false);
                break;
            case 'MAP': // Deprecated but included
                content += createWarning('MAP command is deprecated. Use the map display below.');
                content += createInput('map-game-name', 'text', 'Game Name or *', 'Game Name or *', true, targetGame !== '<game>' ? targetGame : '');
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
                 content += createInput('create-variant', 'text', 'Variant/Options (optional)', 'e.g., Chaos Gunboat machiavelli', false, '', 'Separate multiple options with spaces.');
                 content += createCheckbox('create-become-master', 'Become Master?', false, 'Adds BECOME MASTER command.');
                 break;
            case 'SIGN ON ?':
                 content += createInput('signon-next-password', 'password', 'Password', '', true, '', 'Password for the next available forming game.');
                 break;
            case 'SIGN ON ?game':
                 content += createInput('signon-q-game', 'text', 'Game Name', 'Game Name', true, targetGame !== '<game>' ? targetGame : '', 'Name of the specific forming game.');
                 content += createInput('signon-q-password', 'password', 'Password', '', true);
                 content += createInput('signon-q-variant', 'text', 'Variant/Options (if required)', 'e.g., Chaos Gunboat', false, '', 'Must match game settings if specified.');
                 break;
            case 'SIGN ON power':
                 content += createInput('signon-power', 'text', 'Power Initial', 'e.g., F', true, '', 'Single letter (A, E, F, G, I, R, T for standard).', {size: 1, maxlength: 1});
                 content += createInput('signon-game', 'text', 'Game Name', 'Game Name', true, targetGame !== '<game>' ? targetGame : '');
                 content += createInput('signon-password', 'password', 'Password', '', true);
                 break;
            case 'OBSERVE': case 'WATCH':
                 content += createInput('observe-game', 'text', 'Game Name', 'Game Name', true, targetGame !== '<game>' ? targetGame : '');
                 content += createInput('observe-password', 'password', 'Password', '', true);
                 break;

            // --- In-Game Player Actions ---
            case 'ORDERS':
                 // More interactive order builder
                 if (myUnits.length > 0) {
                     const unitOptions = [{value:'', text:'-- Select Unit --'}, ...myUnits.map(u => ({value: `${u.type} ${u.location}`, text: `${u.type} ${u.location}`}))];
                     content += createSelect('order-unit-select', 'Unit to Order', unitOptions, false, 'Select a unit to build its order.');
                 } else {
                     content += createInfo('No units found for your power in the current game state.');
                 }
                 content += `<div id="order-details-area" class="mt-2 border-t pt-2 hidden"></div>`; // Area for specific order options
                 content += createInfo('Alternatively, enter orders directly into the text area below.');
                 content += createInfo('Example: <code class="bg-gray-100 px-1 py-0.5 rounded">A Par H</code>, <code class="bg-gray-100 px-1 py-0.5 rounded">F Lon - Nth</code>');
                 content += createWarning('Specify full convoy routes: <code class="bg-gray-100 px-1 py-0.5 rounded">A Lon-Nth-Nwy</code>');
                 generatedCommandTextarea.placeholder = "Select unit above or enter orders here...\ne.g., A PAR H\nF BRE - MAO";
                 // Add event listener to unit select
                 setTimeout(() => {
                     qs('#order-unit-select')?.addEventListener('change', () => handleUnitOrderSelection(gameData));
                 }, 0);
                 break;
            case 'PRESS': case 'BROADCAST':
                 // Press options
                 content += `<fieldset class="border p-2 rounded"><legend class="text-sm font-medium px-1">Press Options</legend>`;
                 // Color
                 if (gameData?.settings?.press?.includes('/')) { // White/Grey or Grey/White
                     const defaultColor = gameData.settings.press.startsWith('Grey') ? 'GREY' : 'WHITE';
                     content += createRadio('press-color-default', 'press-color', `Default (${defaultColor})`, true);
                     content += createRadio('press-color-white', 'press-color', 'White', defaultColor === 'GREY');
                     content += createRadio('press-color-grey', 'press-color', 'Grey', defaultColor === 'WHITE');
                 }
                 // Delivery
                 content += createRadio('press-delivery-all', 'press-delivery', 'To All (Broadcast)', selectedCommand === 'BROADCAST');
                 content += createRadio('press-delivery-list', 'press-delivery', 'To List', selectedCommand === 'PRESS');
                 content += createRadio('press-delivery-but', 'press-delivery', 'To All BUT List');
                 content += `<div id="press-powerlist-div" class="${selectedCommand === 'BROADCAST' ? 'hidden' : ''}">${createPowerCheckboxes('press-to', gameData)}</div>`;
                 // Fake
                 if (gameData?.settings?.partialPress && !gameData?.settings?.press?.includes('No Fake')) {
                     content += createCheckbox('press-fake-broadcast', 'Fake as Broadcast?', false);
                     content += createCheckbox('press-fake-partial-cb', 'Fake as Partial?', false);
                     content += `<div id="press-fakelist-div" class="hidden">Fake To/But: ${createPowerCheckboxes('press-fake-to', gameData)}</div>`;
                 }
                 content += `</fieldset>`;
                 content += createTextarea('press-body', 'Press Message Body', '', true, 4);
                 content += createInfo(`Command will end with ENDPRESS.`);
                 generatedCommandTextarea.placeholder = "Enter message body here...";
                 // Add event listeners
                 setTimeout(() => {
                     optionsArea.querySelectorAll('input[name="press-delivery"]').forEach(el => el.addEventListener('change', handlePressDeliveryChange));
                     qs('#press-fake-partial-cb')?.addEventListener('change', handlePressFakePartialChange);
                 }, 0);
                 break;
            case 'POSTAL PRESS':
                 content += createTextarea('press-body', 'Postal Press Message Body', '', true, 4);
                 content += createWarning('Postal Press is broadcast-only and delivered after the turn processes.');
                 content += createInfo(`Command will end with ENDPRESS.`);
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
                         const numInput = numDiv.querySelector('#diary-entry-num');
                         const bodyInput = bodyDiv.querySelector('#diary-body');
                         if (numInput) numInput.required = (action === 'READ' || action === 'DELETE');
                         if (bodyInput) bodyInput.required = (action === 'RECORD');
                         updateGeneratedCommandText(gameData); // Update command text when visibility changes
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
                 content += createInfo('Vote for a draw this phase.');
                 if (gameData?.settings?.dias === false) { // NoDIAS game
                     content += createInfo('Game is NoDIAS. Select powers to include (optional):');
                     content += createPowerCheckboxes('draw-powers', gameData, false, false); // No M or O in draw list
                 } else {
                     content += createInfo('Game is DIAS (Draw Includes All Survivors).');
                 }
                 break;
             case 'SET CONCEDE':
                 content += createInput('concede-power', 'text', 'Power Initial to Concede To', 'e.g., F', true, '', 'Must be the largest power. Check LIST output.', {size: 1, maxlength: 1});
                 break;
             case 'SET PREFERENCE':
                 content += createInput('preference-list', 'text', 'Preference List', 'e.g., E[FGR][TAI] or *', true, '', 'Only effective in forming games.');
                 content += createInfo('Use initials (A,E,F,G,I,R,T for standard). Use * for random (if allowed).');
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

            // --- Machiavelli Specific Player Commands ---
            case 'BORROW':
                if (!isMachiavelliGame || !gameData?.settings?.money) { content += createError('BORROW command only available in Machiavelli games with money enabled.'); break; }
                content += createInput('borrow-amount', 'number', 'Amount (Ducats)', 'e.g., 10', true, '', '', {min: 1});
                content += createSelect('borrow-duration', 'Duration', [
                    {value: 'FOR 1 YEAR', text: 'For 1 Year (20% interest)'},
                    {value: 'FOR 2 YEARS', text: 'For 2 Years (50% interest)'}
                ], true);
                break;
            case 'GIVE': case 'PAY': // PAY is often used for "GIVE ... TO BANK"
                if (!isMachiavelliGame || !gameData?.settings?.money) { content += createError(`${selectedCommand} command only available in Machiavelli games with money enabled.`); break; }
                content += createInput('give-amount', 'number', 'Amount (Ducats)', 'e.g., 5', true, '', '', {min: 1});
                content += createInput('give-recipient', 'text', 'Recipient (Power Name/Abbr or "BANK")', 'e.g., Milan or BANK', true);
                content += createInfo('Use "GIVE <power_chit> TO <power>" for assassination chits.');
                break;
            case 'ALLY':
                if (!isMachiavelliGame) { content += createError('ALLY command is typically for Machiavelli games (strait control).'); break; }
                content += createInput('ally-power', 'text', 'Power to Ally/Unally', 'e.g., Naples', true);
                content += createInfo('Use ALLY to allow passage, UNALLY to revoke.');
                break;
            case 'EXPENSE':
                if (!isMachiavelliGame || !gameData?.settings?.money) { content += createError('EXPENSE command only available in Machiavelli games with money enabled.'); break; }
                content += createSelect('expense-number', 'Expense #', [{value:1,text:'1'},{value:2,text:'2'},{value:3,text:'3'},{value:4,text:'4'}], true);
                content += createInput('expense-amount', 'number', 'Amount (Ducats)', 'e.g., 12', true, '', '', {min:0});
                content += createSelect('expense-type', 'Expense Type (etype)', [
                    {value: '', text: '-- Select Type --'},
                    {value: 'FAMINE RELIEF', text: 'Famine Relief (fr)'},
                    {value: 'PACIFY REBELLION', text: 'Pacify Rebellion (pr)'},
                    {value: 'COUNTER-BRIBE', text: 'Counter-Bribe (cb)'},
                    {value: 'DISBAND', text: 'Disband Unit (d)'},
                    {value: 'BUY', text: 'Buy Unit (b)'},
                    {value: 'GARRISON TO AUTONOMOUS', text: 'Garrison to Autonomous (gta)'},
                    {value: 'CAUSE REBELLION', text: 'Cause Rebellion (cr)'},
                    {value: 'ASSASSINATE', text: 'Assassinate (a)'},
                    {value: 'NONE', text: 'None (remove expense)'}
                ], true);
                content += `<div id="expense-details-area" class="mt-2 border-t pt-2 hidden"></div>`;
                setTimeout(() => {
                    qs('#expense-type')?.addEventListener('change', () => handleExpenseTypeChange(gameData));
                    handleExpenseTypeChange(gameData); // Initial call
                },0);
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
                 content += createInput(`set-${selectedCommand.toLowerCase().substring(4)}-date`, 'text', 'Date/Time', 'e.g., Mon Jan 1 23:00 or +24h', true);
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
                 content += createInput('set-variant-name', 'text', 'Variant/Option Name', 'e.g., Chaos or Gunboat machiavelli', true);
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
             // Machiavelli specific SET commands
             case 'SET MACH2': case 'SET SUMMER': case 'SET MONEY': case 'SET DICE':
             case 'SET LOANS': case 'SET BANK': case 'SET BANKERS':
             case 'SET FAMINE': case 'SET PLAGUE': case 'SET STORM':
             case 'SET ASSASSINS': case 'SET ASSASSINATION': case 'SET GARRISONS':
             case 'SET SPECIAL': case 'SET FORTRESSES': case 'SET FORTS':
             case 'SET ADJACENCY': case 'SET ADJACENT': case 'SET COASTAL CONVOYS': case 'SET DISBAND':
             case 'SET ATTACKTRANSFORM':
                  content += createWarning('Master Only.');
                  content += createInfo(`Applies setting: ${selectedCommand}. Check docs for specific value requirements if any.`);
                  generatedCommandTextarea.value = selectedCommand + ' '; // Start with command
                  break;
            case 'SET TRANSFORM':
                content += createWarning('Master Only.');
                content += createInfo('Example: SET TRANSFORM MOVE:HOMECENTRE BUILD:ANYWHERE or SET TRANSFORM NONE');
                content += createInput('set-transform-value', 'text', 'Transform Setting', 'e.g., MOVE:ANYWHERE or NONE', true);
                break;


            // --- Manual / Default ---
             case 'MANUAL':
                 content += createInfo('Enter the full command manually in the text area below. Do NOT include SIGN OFF.');
                 content += createInfo('The server will prepend SIGN ON automatically if needed for the target game.');
                 generatedCommandTextarea.placeholder = "Type full command here (e.g., WHOIS someone@example.com)";
                 break;
            default:
                content += createInfo(`Parameters for <strong>${selectedCommand}</strong> (if any) should be entered directly in the text area below.`);
                content += createInfo(`Check <code class="bg-gray-100 px-1 py-0.5 rounded">HELP ${selectedCommand}</code> or the docs if unsure.`);
                generatedCommandTextarea.value = selectedCommand + ' '; // Start with the command verb
                break;
        }
        content += '</div>'; // Close space-y-1
        optionsArea.innerHTML = content;

        // Attach listeners to new inputs/selects/textareas AFTER they are in the DOM
        setTimeout(() => {
            optionsArea.querySelectorAll('input, select, textarea').forEach(el => {
                // Use 'input' for text fields, 'change' for select/checkbox/radio
                const eventType = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'radio') ? 'change' : 'input';
                el.removeEventListener(eventType, () => updateGeneratedCommandText(gameData)); // Remove old listener if any
                el.addEventListener(eventType, () => updateGeneratedCommandText(gameData));
            });
            updateGeneratedCommandText(gameData); // Update text area based on initial options
        }, 0); // Timeout ensures DOM update is processed
    }

    // qs and qsa helpers moved to DOMContentLoaded scope

    // --- updateGeneratedCommandText: Updated for multi-line and complex commands ---
    // Pass gameData to this function
    function updateGeneratedCommandText(gameData) {
        if (!commandTypeSelect || !generatedCommandTextarea || !optionsArea) return; // Check elements exist

        const selectedCommand = commandTypeSelect.value;
        const currentText = generatedCommandTextarea.value; // Preserve user input if possible

        if (!selectedCommand && selectedCommand !== 'ORDERS') { // Allow ORDERS to proceed even if dropdown is "" but unit selected
            // If no command type is selected (e.g. "-- Select Action --")
            // and it's not the special ORDERS case (which might be driven by unit selection),
            // we generally don't want to auto-generate or clear the textarea,
            // allowing for manual input.
            return;
        }

        let commandString = ''; // Will be set by buildCommandStringFromOptions or be empty for ORDERS/MANUAL
        let commandBody = '';   // Will be set for multi-line commands or by buildSingleOrderStringFromUI

        // Build the command string based on options (usually the first line)
        commandString = buildCommandStringFromOptions(selectedCommand, gameData); // Pass gameData

        const commandsWithBodyInput = ['PRESS', 'BROADCAST', 'POSTAL PRESS', 'DIARY', 'PHASE', 'IF', 'BECOME', 'SET COMMENT BEGIN'];

        if (selectedCommand === 'ORDERS') {
            commandString = ''; // No "ORDERS" prefix in the textarea
            commandBody = buildOrderLinesFromUI(gameData, currentText); // Use new helper for potentially multiple order lines
        } else if (selectedCommand === 'MANUAL') {
            commandString = '';
            commandBody = currentText; // Manual is purely user input
        } else if (commandsWithBodyInput.includes(selectedCommand)) {
            // Try to preserve existing body if user was editing it
            const lines = currentText.split('\n');
            let potentialBodyStartLine = 0;

            const generatedLines = commandString.split('\n');
            potentialBodyStartLine = generatedLines.length;

            let prefixMatches = true;
            if (potentialBodyStartLine > 0) {
                for (let i = 0; i < potentialBodyStartLine; i++) {
                    if (i >= lines.length || lines[i].trim() !== generatedLines[i].trim()) {
                        prefixMatches = false;
                        break;
                    }
                }
            } else {
                prefixMatches = false;
            }

            if (prefixMatches && lines.length >= potentialBodyStartLine) {
                commandBody = lines.slice(potentialBodyStartLine).join('\n');
            } else {
                // Generate default/placeholder body if needed (prefix didn't match or no body yet)
                if (['PRESS', 'BROADCAST', 'POSTAL PRESS'].includes(selectedCommand)) {
                    commandBody = qs('#press-body')?.value || '';
                    if (!commandBody && currentText.includes('ENDPRESS')) commandBody = '';
                    else if (!commandBody) commandBody = '<message body>';
                    commandBody += '\nENDPRESS';
                } else if (selectedCommand === 'DIARY' && qs('#diary-action')?.value === 'RECORD') {
                    commandBody = qs('#diary-body')?.value || '';
                    if (!commandBody && currentText.includes('ENDPRESS')) commandBody = '';
                    else if (!commandBody) commandBody = '<diary entry>';
                    commandBody += '\nENDPRESS';
                } else if (['PHASE', 'IF', 'BECOME'].includes(selectedCommand)) {
                    commandBody = '<orders/commands>';
                } else if (selectedCommand === 'SET COMMENT BEGIN') {
                    commandBody = qs('#set-comment-begin-text')?.value || '<long comment text>';
                }
            }
        }
        // For commands not in commandsWithBodyInput and not ORDERS/MANUAL, commandBody remains empty.
        // commandString will hold the generated command.

        // Construct final output
        let finalOutput = commandString;
        // Append commandBody if it exists (for ORDERS or commandsWithBodyInput)
        if (commandBody) {
            if (finalOutput.length > 0 && !finalOutput.endsWith('\n')) {
                finalOutput += '\n';
            }
            finalOutput += commandBody;
        }


        // Only update if the generated text is different from current text,
        // to avoid cursor jumping during manual edits in body section.
        // Also, if selectedCommand is empty but it's not ORDERS, we might have returned early.
        // If selectedCommand is empty AND it IS orders (because a unit is selected), we proceed.
        currentGeneratedCommand = finalOutput;
        // The generatedCommandTextarea itself is NOT updated here.
        // It will only be updated when the "Add to Command Box" button is clicked,
        // or if the user types into it manually (which then updates currentGeneratedCommand via the 'input' event listener).
    }

    // Helper to build the command string from options (first line usually)
    // Pass gameData to this function
    function buildCommandStringFromOptions(selectedCommand, gameData) {
        let commandString = selectedCommand;
        // Helpers val, rawVal, checked are now in DOMContentLoaded scope
        const getCheckedValues = (name) => Array.from(qsa(`input[name="${name}"]:checked`)).map(el => el.value);
        const isMachiavelliGame = gameData?.settings?.isMachiavelli || gameData?.variant?.toLowerCase().includes('machiavelli');
        const currentPhaseType = gameData?.currentPhase?.slice(-1).toUpperCase();


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
            case 'PRESS': case 'BROADCAST':
                commandString = selectedCommand;
                const colorOption = radioVal('press-color', 'default');
                if (colorOption !== 'default') commandString += ` ${colorOption}`;
                const deliveryOption = radioVal('press-delivery', 'all');
                const powerList = getCheckedValues('press-to-power').join('');
                if (deliveryOption === 'list' && powerList) commandString += ` TO ${powerList}`;
                else if (deliveryOption === 'but' && powerList) commandString += ` TO ALL BUT ${powerList}`;
                else if (deliveryOption !== 'all' && selectedCommand === 'PRESS') { commandString += ' TO <list>'; /* Placeholder if list empty */ }
                else if (deliveryOption === 'all' && selectedCommand === 'PRESS') { commandString += ' TO ALL'; } // Explicit TO ALL for PRESS

                const fakeBroadcast = checked('#press-fake-broadcast');
                const fakePartial = checked('#press-fake-partial-cb');
                const fakePowerList = getCheckedValues('press-fake-to-power').join('');

                if (fakeBroadcast) commandString += ' FAKE BROADCAST';
                else if (fakePartial && fakePowerList) commandString += ` FAKE PARTIAL TO ${fakePowerList}`;
                else if (fakePartial) commandString += ' FAKE PARTIAL TO <list>'; // Placeholder

                break; // Body handled separately
            case 'POSTAL PRESS': commandString = selectedCommand; break; // Body handled separately
            case 'DIARY': const diaryAction = val('#diary-action'); commandString = `DIARY ${diaryAction}`; if (diaryAction === 'READ' || diaryAction === 'DELETE') { commandString += ` ${val('#diary-entry-num', '<number>')}`; } break; // Body handled separately for RECORD
            case 'RESIGN': case 'WITHDRAW': commandString = selectedCommand; break;

            // --- In-Game Player Settings / Future Orders ---
             case 'SET WAIT': case 'SET NOWAIT': case 'SET NOABSENCE': case 'SET NODRAW': case 'SET NOCONCEDE': case 'CLEAR': commandString = selectedCommand; break;
             case 'SET ABSENCE': case 'SET HOLIDAY': case 'SET VACATION': const absStart = val('#absence-start', '<start_date>'); const absEnd = val('#absence-end'); commandString = `SET ABSENCE ${absStart}`; if (absEnd) commandString += ` TO ${absEnd}`; break;
             case 'SET DRAW':
                 commandString = `SET DRAW`;
                 if (gameData?.settings?.dias === false) { // NoDIAS
                     const drawPowersList = getCheckedValues('draw-powers-power').join('');
                     if (drawPowersList) commandString += ` ${drawPowersList}`;
                 }
                 break;
             case 'SET CONCEDE': commandString = `SET CONCEDE ${val('#concede-power', '<P>').toUpperCase()}`; break;
             case 'SET PREFERENCE': commandString = `SET PREFERENCE ${val('#preference-list', '<list_or_*>')}`; break;
             case 'PHASE': commandString = `PHASE ${val('#phase-season', '<Season>')} ${val('#phase-year', '<Year>')} ${val('#phase-type', '<Phase>')}`; break; // Body handled separately
             case 'IF': commandString = `IF ${rawVal('#if-condition', '<condition>')}`; break; // Body handled separately

            // --- Machiavelli Specific Player Commands ---
            case 'BORROW':
                commandString = `BORROW ${val('#borrow-amount', '0')} DUCATS ${val('#borrow-duration', 'FOR 1 YEAR')}`;
                break;
            case 'GIVE': case 'PAY':
                commandString = `${selectedCommand.toUpperCase()} ${val('#give-amount', '0')} DUCATS TO ${val('#give-recipient', '<RECIPIENT>')}`;
                break;
            case 'ALLY':
                commandString = `ALLY ${val('#ally-power', '<POWER>')}`;
                break;
            case 'EXPENSE':
                const expenseNum = val('#expense-number', '1');
                const expenseAmt = val('#expense-amount', '0');
                const expenseType = val('#expense-type', '<ETYPE>');
                commandString = `EXPENSE ${expenseNum}: ${expenseAmt} DUCATS ${expenseType}`;
                if (expenseType !== 'NONE' && expenseType !== 'ASSASSINATE' && expenseType !== 'FAMINE RELIEF' && expenseType !== 'PACIFY REBELLION') {
                    const unitType = val('#expense-unit-type', '');
                    const province = val('#expense-province', '<PROVINCE>');
                    if (unitType) commandString += ` ${unitType.toUpperCase()}`;
                    commandString += ` ${province.toUpperCase()}`;
                } else if (expenseType === 'ASSASSINATE') {
                    commandString += ` ${val('#expense-target-power', '<POWER>')}`;
                } else if (expenseType === 'FAMINE RELIEF' || expenseType === 'PACIFY REBELLION') {
                    commandString += ` ${val('#expense-province', '<PROVINCE>')}`;
                }
                break;

            // --- Master Commands ---
             case 'BECOME MASTER': case 'SET MODERATE': case 'SET UNMODERATE': case 'FORCE BEGIN': case 'PAUSE': case 'RESUME': case 'TERMINATE': case 'PREDICT': case 'UNSTART': commandString = selectedCommand; break;
             case 'BECOME': commandString = `BECOME ${val('#become-power', '<power>')}`; break; // Body handled separately
             case 'EJECT': commandString = `EJECT ${val('#eject-target', '<power_or_email>')}`; break;
             case 'PROMOTE': commandString = `PROMOTE ${val('#promote-observer', '<observer_email>')}`; break;
             case 'PROCESS': const procPhase = val('#process-phase'); commandString = `PROCESS`; if (procPhase) commandString += ` ${procPhase}`; break;
             case 'ROLLBACK': const rbTurn = val('#rollback-turn'); commandString = `ROLLBACK`; if (rbTurn) commandString += ` ${rbTurn}`; break;

            // --- Master Settings ---
             case 'SET': commandString = `SET ${val('#set-option', '<option>')} ${rawVal('#set-value', '<value>')}`; break;
             case 'SET DEADLINE': case 'SET GRACE': case 'SET START': commandString = `${selectedCommand} ${val(`set-${selectedCommand.toLowerCase().substring(4)}-date`, '<date>')}`; break;
             case 'SET COMMENT': commandString = `SET COMMENT ${val('#set-comment-text', '<text>')}`; break;
             case 'SET COMMENT BEGIN': commandString = `SET COMMENT BEGIN`; break; // Body handled separately
             // Add other specific SET commands if needed, otherwise use generic SET or MANUAL
             case 'SET NMR': case 'SET NO NMR': case 'SET CD': case 'SET NO CD': commandString = selectedCommand; break;
             case 'SET VARIANT': commandString = `SET VARIANT ${val('#set-variant-name', '<variant_or_option>')}`; break;
             case 'SET NOT VARIANT': commandString = `SET NOT VARIANT ${val('#set-not-variant-name', '<option>')}`; break;
             case 'SET LEVEL': commandString = `SET LEVEL ${val('#set-level-value', 'ANY')}`; break;
             case 'SET OBSERVER': commandString = `SET OBSERVER ${val('#set-observer-value', 'ANY')}`; break;
             case 'SET MAX ABSENCE': commandString = `SET MAX ABSENCE ${val('#set-max-absence-value', '15')}`; break;
             // Generic handler for simple SET commands (most master settings)
             case 'SET ALL PRESS': case 'SET NORMAL PRESS': case 'SET QUIET': case 'SET NO QUIET':
             case 'SET WATCH ALL PRESS': case 'SET NO WATCH ALL PRESS': case 'SET ACCESS':
             case 'SET ALLOW PLAYER': case 'SET DENY PLAYER': case 'SET DEDICATION':
             case 'SET ONTIMERAT': case 'SET RESRAT': case 'SET APPROVAL': case 'SET APPROVE': case 'SET NOT APPROVE':
             case 'SET BLANK PRESS': case 'SET BROADCAST': case 'SET NORMAL BROADCAST': case 'SET NO FAKE':
             case 'SET GREY': case 'SET NO WHITE': case 'SET GREY/WHITE': case 'SET LATE PRESS':
             case 'SET MINOR PRESS': case 'SET MUST ORDER': case 'SET NO PRESS': case 'SET NONE':
             case 'SET PARTIAL': case 'SET PARTIAL FAKES BROADCAST': case 'SET PARTIAL MAY':
             case 'SET POSTAL PRESS': case 'SET WHITE': case 'SET WHITE/GREY':
             case 'SET LATE COUNT': case 'SET STRICT GRACE': case 'SET STRICT WAIT': case 'SET MOVE':
             case 'SET RETREAT': case 'SET ADJUST': case 'SET CONCESSIONS': case 'SET DIAS': case 'SET LIST':
             case 'SET PUBLIC': case 'SET PRIVATE': case 'SET AUTO PROCESS': case 'SET MANUAL PROCESS':
             case 'SET AUTO START': case 'SET MANUAL START': case 'SET RATED': case 'SET UNRATED':
             // Machiavelli specific SET commands
             case 'SET MACH2': case 'SET SUMMER': case 'SET MONEY': case 'SET DICE':
             case 'SET LOANS': case 'SET BANK': case 'SET BANKERS':
             case 'SET FAMINE': case 'SET PLAGUE': case 'SET STORM':
             case 'SET ASSASSINS': case 'SET ASSASSINATION': case 'SET GARRISONS':
             case 'SET SPECIAL': case 'SET FORTRESSES': case 'SET FORTS':
             case 'SET ADJACENCY': case 'SET ADJACENT': case 'SET COASTAL CONVOYS': case 'SET DISBAND':
             case 'SET ATTACKTRANSFORM':
                  commandString = selectedCommand; // Simple SET command, value might be needed in text area
                  break;
            case 'SET TRANSFORM':
                commandString = `SET TRANSFORM ${val('#set-transform-value', 'NONE')}`;
                break;

            // --- Manual ---
             case 'MANUAL': commandString = ''; break; // Body is handled separately

            // --- Default ---
            default: commandString = selectedCommand; break; // Default to just the command verb if no options defined
        }
        return commandString.trim(); // Trim trailing space if no params added
    }

    // --- Event Listeners ---
    if (commandTypeSelect) {
        commandTypeSelect.addEventListener('change', () => {
            generateCommandOptions(commandTypeSelect.value, window.currentGameData); // Pass gameData
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
            const gameName = targetGameInput?.value;
            if (gameName) {
                 if (outputDiv) {
                     outputDiv.textContent = `Refreshing state for ${gameName}...`;
                     outputDiv.className = 'bg-blue-50 border border-blue-200 rounded-md p-4 font-mono text-sm min-h-[250px] max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words text-blue-700';
                 }
                 // Fetch state directly instead of sending LIST command via execute
                 fetchAndDisplayGameState(gameName);
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
        if (!generatedCommandTextarea || !outputDiv || !sendButton || !targetGameInput || !targetPasswordInput || !targetVariantInput) {
            console.error("One or more required elements are missing for sendCommand.");
            alert("Error: UI elements missing, cannot send command.");
            return;
        }

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
                 // Handle non-JSON or error responses
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
                    const confirmedGameName = result.createdGameName || targetGame || result.refreshedGameState?.name; // Try to get confirmed name
                    outputDiv.textContent += `\n\nSign On / Observe / Create Successful${confirmedGameName ? ` for ${confirmedGameName}` : ''}! Updating context...`;
                    if (confirmedGameName && gameSelector) {
                         // Check if game exists in list, add if not (relevant for CREATE)
                         if (!Array.from(gameSelector.options).some(opt => opt.value === confirmedGameName)) {
                              console.log(`Game ${confirmedGameName} not in selector, fetching full list...`);
                              fetchAndPopulateGames(); // Fetch full list to include the new game
                              // Selection will be handled by fetchAndPopulateGames after list updates
                         } else {
                              // Game already exists, just select it
                              gameSelector.value = confirmedGameName;
                              if (targetGameInput) targetGameInput.value = confirmedGameName;
                              loadCredentialsForGame(confirmedGameName);
                         }

                         // If state wasn't included in *this* response, fetch it explicitly
                         // This fetch will also get the correct recommendations
                         if (!stateToUpdateUI) {
                             console.log("[sendCommand] SignOn success but no refreshed state, fetching...");
                             // Use a timeout to allow fetchAndPopulateGames to potentially finish first if needed
                             setTimeout(() => fetchAndDisplayGameState(confirmedGameName), 100);
                             stateToUpdateUI = null; // Prevent double update below
                             recommendationsToUpdateUI = null; // Prevent double update below
                         }
                    }
                }

                // If we have a refreshed state, update the sidebar and map
                if (stateToUpdateUI) {
                    console.log("[sendCommand] Updating UI sidebar with state:", stateToUpdateUI);
                    window.currentGameData = stateToUpdateUI; // Update global state variable
                    updateGameStateSidebar(currentGameData);
                    renderMap(stateToUpdateUI.name, stateToUpdateUI.currentPhase); // Update map
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
                // Keep the error output from the server
                outputDiv.textContent = `Command Failed.\n\n${result.output}`;
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


    // --- Game Management ---
    // Add Game Logic
    if (addGameForm) {
        addGameForm.addEventListener('submit', async (event) => {
            event.preventDefault(); // Prevent standard form submission
            displayGameManagementFeedback('Adding game...', false);

            const gameName = addGameNameInput?.value.trim();
            const variant = addGameVariantInput?.value.trim();
            const password = addGamePasswordInput?.value.trim(); // Optional

            if (!gameName || !variant) {
                displayGameManagementFeedback('Game Name and Variant are required.', true);
                return;
            }
            // Require password for API creation for simplicity now
            if (!password) {
                 displayGameManagementFeedback('Master Password is required for game creation via API.', true);
                 return;
            }

            const body = { gameName, variant, password }; // Include password

            try {
                const response = await fetch('/api/games', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                let result;
                let responseTextForError = ''; // Store raw text in case JSON parsing fails
                try {
                    // Clone the response to read its text body in case of JSON error,
                    // as response.json() consumes the body.
                    const responseClone = response.clone();
                    result = await response.json();
                } catch (jsonError) {
                    console.error('Failed to parse server response as JSON:', jsonError);
                    // Attempt to get the raw text from the cloned response if JSON parsing failed
                    try {
                        responseTextForError = await responseClone.text();
                    } catch (textError) {
                        console.error('Failed to read response text after JSON parsing error:', textError);
                        responseTextForError = 'Could not read response body.';
                    }
                    result = {
                        message: `Server returned non-JSON response (Status: ${response.status}). Body: ${responseTextForError}`,
                        success: false // Assume failure if JSON parsing fails
                    };
                }

                if (response.ok) { // HTTP status 200-299 indicates success
                    // Use result.message directly for the success notification.
                    // This message comes from the backend and could be the judge's detailed success message.
                    displayGameManagementFeedback(result.message || `Game '${gameName}' created successfully. Refreshing list...`, false);
                    addGameForm.reset(); // Clear the form fields
                    await fetchAndPopulateGames(); // Refresh the game list
                    // Attempt to select the newly added game in the dropdown
                    if(gameSelector) {
                        setTimeout(() => {
                             if (Array.from(gameSelector.options).some(opt => opt.value === gameName)) {
                                gameSelector.value = gameName;
                                // Trigger change event to load state etc.
                                gameSelector.dispatchEvent(new Event('change'));
                                console.log(`Selected newly added game: ${gameName}`);
                             } else {
                                console.log(`Newly added game ${gameName} not found in selector after refresh.`);
                             }
                        }, 100); // Small delay
                    }
                } else {
                    // Server indicated an error via HTTP status code (4xx, 5xx).
                    // result.message should contain the error details from the backend.
                    const errorMessage = result.message || `Failed to add game (Status: ${response.status}, no specific message from server). Response: ${responseTextForError}`;
                    console.error('Error adding game (server response):', errorMessage, 'Full result:', result);
                    displayGameManagementFeedback(errorMessage, true); // Display as error, using server's message
                }
            } catch (error) { // This catch handles network errors or if the fetch itself fails (e.g., DNS resolution)
                console.error('Network or client-side error adding game:', error);
                // For network errors, a generic message is appropriate.
                displayGameManagementFeedback(`Network or client error adding game: ${error.message}`, true);
            }
        });
    }

    // Remove Game Logic
    if (removeGameBtn && gameSelector) { // Ensure both button and selector exist
        removeGameBtn.addEventListener('click', async () => {
            const gameName = gameSelector.value;
            const password = removeGamePasswordInput?.value.trim(); // Optional

            if (!gameName) {
                displayGameManagementFeedback('Please select a game to remove from the "Target Game" dropdown.', true);
                return;
            }
            // Require password for removal via API for simplicity/security
            if (!password) {
                 displayGameManagementFeedback('Master Password is required for game removal via API.', true);
                 return;
            }

            // Confirmation dialog
            if (!confirm(`Are you sure you want to permanently REMOVE (Terminate) the game "${gameName}"?\n\nThis action cannot be undone.`)) {
                displayGameManagementFeedback('Remove operation cancelled.', false);
                return;
            }

            displayGameManagementFeedback(`Removing game '${gameName}'...`, false);

            const body = { password }; // Send password in body

            try {
                const fetchOptions = {
                    method: 'DELETE',
                    headers: { 'Content-Type': 'application/json' }, // Need content type for body
                    body: JSON.stringify(body)
                };

                const response = await fetch(`/api/games/${encodeURIComponent(gameName)}`, fetchOptions);
                const result = await response.json(); // Assume backend sends JSON

                if (response.ok && result.success) {
                    displayGameManagementFeedback(`Game '${gameName}' removed successfully. Refreshing list...`, false);
                    if (removeGamePasswordInput) removeGamePasswordInput.value = ''; // Clear password field
                    const previouslySelectedGame = window.currentGameData ? window.currentGameData.name : null;

                    await fetchAndPopulateGames(); // Refresh list (removes game from dropdown)

                    // If the removed game was the one currently displayed, clear the sidebar/commands
                    if (previouslySelectedGame === gameName) {
                         console.log(`Clearing state as removed game (${gameName}) was selected.`);
                         updateGameStateSidebar(null); // Clear sidebar
                         updateCommandGenerator(null); // Clear command generator recommendations
                         renderMap(null); // Clear map
                         if (targetGameInput) targetGameInput.value = ''; // Clear hidden input
                         // Optionally clear password/variant fields too? Handled by clear credentials button usually.
                    }
                } else {
                     // Use the error message from the backend if available
                    throw new Error(result.message || `Failed to remove game (Status: ${response.status})`);
                }
            } catch (error) {
                console.error('Error removing game:', error);
                displayGameManagementFeedback(`Error removing game: ${error.message}`, true);
            }
        });
    }

    // Helper for Game Management Feedback
    function displayGameManagementFeedback(message, isError = false) {
        if (!gameManagementFeedbackDiv) return;
        // Clear previous feedback first
        gameManagementFeedbackDiv.innerHTML = '';

        const p = document.createElement('p');
        p.textContent = message;
        p.className = ` ${isError ? 'text-red-600 font-semibold' : 'text-green-600 font-semibold'}`;
        gameManagementFeedbackDiv.appendChild(p);

        // Optional: Clear feedback after a few seconds?
        setTimeout(() => {
            if (gameManagementFeedbackDiv.contains(p)) {
                gameManagementFeedbackDiv.removeChild(p);
            }
        }, 5000); // Clear after 5 seconds
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

    // --- News System ---
    // --- Hypothetical Admin Check ---
    // Replace this with actual logic based on user roles/permissions from the server
    // For now, let's assume admin if the user email is 'admin@example.com' or if no email is present (guest?)
    const isAdmin = !window.currentUserEmail || window.currentUserEmail === 'admin@example.com';
    console.log("Is Admin (for news):", isAdmin);

    // --- Function to Fetch and Display News ---
    async function fetchAndDisplayNews() {
        if (!newsSection || !newsErrorDiv) return; // Elements not found
        newsSection.innerHTML = '<p class="text-gray-500 italic">Loading news...</p>'; // Show loading state
        newsErrorDiv.textContent = ''; // Clear previous errors

        try {
            const response = await fetch('/api/news');
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const result = await response.json();

            if (result.success && Array.isArray(result.news)) {
                newsSection.innerHTML = ''; // Clear loading/previous content
                if (result.news.length === 0) {
                    newsSection.innerHTML = '<p class="text-gray-500 italic">No news items yet.</p>';
                } else {
                    result.news.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp)); // Sort newest first
                    result.news.forEach(item => {
                        const newsItemDiv = document.createElement('div');
                        newsItemDiv.className = 'p-3 border border-gray-200 rounded-md bg-white shadow-sm';

                        const timestamp = new Date(item.timestamp);
                        const formattedTime = !isNaN(timestamp) ? timestamp.toLocaleString() : 'Invalid Date';

                        let contentHTML = `
                            <p class="text-gray-800 mb-1">${item.content}</p>
                            <p class="text-xs text-gray-500">Posted: ${formattedTime}</p>
                        `;

                        if (isAdmin) {
                            contentHTML += `
                                <button
                                    class="delete-news-btn btn bg-red-600 hover:bg-red-700 text-white text-xs py-1 px-2 mt-2"
                                    data-id="${item._id}"
                                    title="Delete this news item"
                                >
                                    Delete
                                </button>
                            `;
                        }

                        newsItemDiv.innerHTML = contentHTML;
                        newsSection.appendChild(newsItemDiv);
                    });
                }
            } else {
                throw new Error(result.message || 'Failed to fetch news or invalid format.');
            }
        } catch (error) {
            console.error('Error fetching news:', error);
            newsSection.innerHTML = '<p class="text-red-600 italic">Could not load news.</p>'; // Clear loading, show error in main section
            newsErrorDiv.textContent = `Error loading news: ${error.message}`; // Show specific error below
        }
    }

    // --- Event Listener for Adding News ---
    if (addNewsForm && newsContentInput && addNewsFeedback) {
        if (isAdmin) {
            addNewsForm.classList.remove('hidden'); // Show form for admins
        }

        addNewsForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            addNewsFeedback.textContent = ''; // Clear previous feedback
            const content = newsContentInput.value.trim();

            if (!content) {
                addNewsFeedback.textContent = 'News content cannot be empty.';
                addNewsFeedback.className = 'text-sm mt-2 text-red-600';
                return;
            }

            try {
                const response = await fetch('/api/news', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content })
                });
                const result = await response.json();

                if (response.ok && result.success) {
                    newsContentInput.value = ''; // Clear textarea
                    addNewsFeedback.textContent = 'News added successfully!';
                    addNewsFeedback.className = 'text-sm mt-2 text-green-600';
                    fetchAndDisplayNews(); // Refresh the news list
                } else {
                    throw new Error(result.message || `Failed to add news (Status: ${response.status})`);
                }
            } catch (error) {
                console.error('Error adding news:', error);
                addNewsFeedback.textContent = `Error: ${error.message}`;
                addNewsFeedback.className = 'text-sm mt-2 text-red-600';
            }
        });
    }

    // --- Event Listener for Deleting News (Event Delegation) ---
    if (newsSection) {
        newsSection.addEventListener('click', async (e) => {
            if (e.target.classList.contains('delete-news-btn')) {
                const button = e.target;
                const newsId = button.dataset.id;

                if (!newsId) {
                    console.error('Delete button clicked but no ID found.');
                    if (newsErrorDiv) newsErrorDiv.textContent = 'Error: Could not identify news item to delete.';
                    return;
                }

                if (!confirm('Are you sure you want to delete this news item?')) {
                    return;
                }

                if (newsErrorDiv) newsErrorDiv.textContent = ''; // Clear previous errors
                button.disabled = true; // Prevent double clicks
                button.textContent = 'Deleting...';

                try {
                    const response = await fetch(`/api/news/${newsId}`, {
                        method: 'DELETE'
                    });
                    const result = await response.json();

                    if (response.ok && result.success) {
                        console.log('News item deleted successfully:', newsId);
                        fetchAndDisplayNews(); // Refresh the list
                    } else {
                        throw new Error(result.message || `Failed to delete news item (Status: ${response.status})`);
                    }
                } catch (error) {
                    console.error('Error deleting news:', error);
                    if (newsErrorDiv) newsErrorDiv.textContent = `Error deleting news: ${error.message}`;
                     // Re-enable button on error if needed, or let refresh handle it
                     button.disabled = false;
                     button.textContent = 'Delete';
                }
            }
        });
    }


    // --- Helper function to build a single order string from UI fields ---
    // This function is now replaced by buildOrderLinesFromUI for multi-line orders
    function buildSingleOrderStringFromUI(gameData, currentTextareaValue) {
        // This function can be kept for simple, single-line order generation if needed,
        // or fully replaced by buildOrderLinesFromUI.
        // For now, let's assume buildOrderLinesFromUI handles all order generation.
        return buildOrderLinesFromUI(gameData, currentTextareaValue);
    }

    // --- Helper function to build potentially multiple order lines ---
    function buildOrderLinesFromUI(gameData, currentTextareaValue) {
        const unitSelect = qs('#order-unit-select');
        if (!unitSelect || !unitSelect.value) {
            // If no unit is selected, preserve manual input in textarea
            return currentTextareaValue;
        }

        const selectedUnitFull = unitSelect.value; // e.g., "A PAR"
        const [unitType, unitLocation] = selectedUnitFull.split(' ');
        const isMachiavelliGame = gameData?.settings?.isMachiavelli || gameData?.variant?.toLowerCase().includes('machiavelli');
        const currentPhaseType = gameData?.currentPhase?.slice(-1).toUpperCase(); // M, R, A/B

        const orderTypeRadioName = `order-type-${unitLocation}`;
        const selectedOrderTypeFull = radioVal(orderTypeRadioName);

        if (!selectedOrderTypeFull) {
            return `${unitType} ${unitLocation} ...`; // Incomplete
        }

        const typeParts = selectedOrderTypeFull.split('-');
        const orderActionType = typeParts[2]; // "move", "hold", "support", "convoy", "convert", "besiege", "lift", "transform"

        let command = `${unitType} ${unitLocation}`;

        switch (orderActionType) {
            case 'hold': command += ' H'; break;
            case 'move':
                const dest = val(`#order-move-dest-${unitLocation}`);
                const coast = val(`#order-move-coast-${unitLocation}`);
                let convoyRoute = val(`#order-convoy-route-${unitLocation}`);
                if (!dest) return `${command} - ...`;
                command += ` - ${dest.toUpperCase()}`;
                if (coast) command += coast.startsWith('/') ? coast.toUpperCase() : `/${coast.toUpperCase()}`;
                if (convoyRoute) { // For standard Dip and Machiavelli Army moves
                    convoyRoute = convoyRoute.split('-').map(p => p.trim().toUpperCase()).join('-');
                    command += `-${convoyRoute}`; // Append directly for A LON-NTH-NWY
                }
                break;
            case 'support':
                const supportTargetUnit = val(`#order-support-target-unit-${unitLocation}`);
                let supportTargetAction = val(`#order-support-target-action-${unitLocation}`);
                if (!supportTargetUnit) return `${command} S ...`;
                command += ` S ${supportTargetUnit.toUpperCase()}`;
                if (supportTargetAction) command += ` ${supportTargetAction.toUpperCase()}`;
                else command += ' H';
                break;
            case 'convoy': // Standard Dip and Machiavelli Fleet convoy
                const convoyArmy = val(`#order-convoy-army-${unitLocation}`);
                const convoyDest = val(`#order-convoy-dest-${unitLocation}`);
                if (!convoyArmy || !convoyDest) return `${command} C ...`;
                command += ` C ${convoyArmy.toUpperCase()} - ${convoyDest.toUpperCase()}`;
                break;
            // Machiavelli specific order actions
            case 'convert':
                if (!isMachiavelliGame) return `${command} ... (Convert only in Machiavelli)`;
                const convertToType = val(`#order-convert-to-type-${unitLocation}`);
                const convertCoast = val(`#order-convert-coast-${unitLocation}`);
                if (!convertToType) return `${command} C ...`;
                command += ` C ${convertToType.toUpperCase()}`;
                if (convertCoast) command += ` ${convertCoast.startsWith('/') ? convertCoast.toUpperCase() : `/${convertCoast.toUpperCase()}`}`;
                break;
            case 'besiege':
                if (!isMachiavelliGame) return `${command} ... (Besiege only in Machiavelli)`;
                command += ' B'; // Besiege implies target is the garrison in the current province
                break;
            case 'liftsiege': // Renamed from 'lift' to avoid conflict
                if (!isMachiavelliGame) return `${command} ... (Lift Siege only in Machiavelli)`;
                command += ' LS';
                break;
            case 'transform': // Movement phase transform
                if (!isMachiavelliGame || !gameData?.settings?.transform?.move) return `${command} ... (Transform only if enabled)`;
                const transformToType = val(`#order-transform-to-type-${unitLocation}`);
                const transformCoast = val(`#order-transform-coast-${unitLocation}`);
                if (!transformToType) return `${command} TRANSFORMS TO ...`;
                command += ` TRANSFORMS TO ${transformToType.toUpperCase()}`;
                if (transformCoast) command += ` ${transformCoast.startsWith('/') ? transformCoast.toUpperCase() : `/${transformCoast.toUpperCase()}`}`;
                break;
            // Adjustment phase orders for Machiavelli (Build, Remove, Maintain, Transform)
            case 'build': // Machiavelli build (can be special unit)
                if (!isMachiavelliGame || currentPhaseType !== 'A') return `BUILD ... (Build only in Machiavelli Adjustment)`;
                const buildSpecialType = val(`#order-build-special-${unitLocation}`);
                const buildUnitType = val(`#order-build-type-${unitLocation}`);
                command = `BUILD`;
                if (buildSpecialType) command += ` ${buildSpecialType.toUpperCase()}`;
                command += ` ${buildUnitType.toUpperCase()} ${unitLocation.toUpperCase()}`;
                // Coast might be needed if building a fleet in multi-coastal province
                const buildCoast = val(`#order-build-coast-${unitLocation}`);
                if (buildUnitType.toUpperCase() === 'F' && buildCoast) command += ` ${buildCoast.startsWith('/') ? buildCoast.toUpperCase() : `/${buildCoast.toUpperCase()}`}`;
                break;
            case 'remove': // Machiavelli remove
                if (!isMachiavelliGame || currentPhaseType !== 'A') return `REMOVE ... (Remove only in Machiavelli Adjustment)`;
                command = `REMOVE ${unitType.toUpperCase()} ${unitLocation.toUpperCase()}`;
                break;
            case 'maintain': // Machiavelli maintain
                if (!isMachiavelliGame || currentPhaseType !== 'A') return `MAINTAIN ... (Maintain only in Machiavelli Adjustment)`;
                command = `MAINTAIN ${unitType.toUpperCase()} ${unitLocation.toUpperCase()}`;
                break;
            case 'transformadj': // Adjustment phase transform
                if (!isMachiavelliGame || currentPhaseType !== 'A' || !gameData?.settings?.transform?.build) return `TRANSFORM ... (Adj Transform only if enabled)`;
                const adjTransformToType = val(`#order-adj-transform-to-type-${unitLocation}`);
                const adjTransformCoast = val(`#order-adj-transform-coast-${unitLocation}`);
                if (!adjTransformToType) return `TRANSFORM ...`;
                command = `TRANSFORM ${adjTransformToType.toUpperCase()} ${unitLocation.toUpperCase()}`;
                if (adjTransformCoast) command += ` ${adjTransformCoast.startsWith('/') ? adjTransformCoast.toUpperCase() : `/${adjTransformCoast.toUpperCase()}`}`;
                break;
            default:
                return `${unitType} ${unitLocation} ...`; // Unknown
        }

        // For ORDERS, we want to replace only the line corresponding to the selected unit,
        // or append if it's a new order for that unit.
        const lines = currentTextareaValue.split('\n');
        const unitOrderPrefix = `${unitType} ${unitLocation}`;
        let orderFound = false;
        const newLines = lines.map(line => {
            if (line.trim().startsWith(unitOrderPrefix)) {
                orderFound = true;
                return command; // Replace existing order for this unit
            }
            return line;
        });

        if (!orderFound) {
            // If it's a new order for this unit, and the last line isn't empty, add a newline.
            if (newLines.length > 0 && newLines[newLines.length - 1].trim() !== "") {
                newLines.push(command);
            } else if (newLines.length > 0) { // Last line is empty or just whitespace
                newLines[newLines.length -1] = command;
            }
            else { // Textarea was empty
                newLines.push(command);
            }
        }
        return newLines.join('\n');
    }


    // --- Helper functions for dynamic command options (PRESS, ORDERS UI) ---
    function handlePressDeliveryChange() {
        const deliveryType = radioVal('press-delivery');
        const powerListDiv = qs('#press-powerlist-div');
        if (powerListDiv) {
            powerListDiv.classList.toggle('hidden', deliveryType === 'all');
        }
    }

    function handlePressFakePartialChange() {
        const fakePartialChecked = checked('#press-fake-partial-cb');
        const fakeListDiv = qs('#press-fakelist-div');
        if (fakeListDiv) {
            fakeListDiv.classList.toggle('hidden', !fakePartialChecked);
        }
    }

    function handleUnitOrderSelection(gameData) { // Pass gameData
        const selectedUnit = qs('#order-unit-select').value;
        const detailsArea = qs('#order-details-area');
        if (!detailsArea) return;

        detailsArea.innerHTML = ''; // Clear previous
        detailsArea.classList.toggle('hidden', !selectedUnit);

        if (selectedUnit) {
            const [unitType, unitLocation] = selectedUnit.split(' ');
            const isMachiavelliGame = gameData?.settings?.isMachiavelli || gameData?.variant?.toLowerCase().includes('machiavelli');
            const currentPhaseType = gameData?.currentPhase?.slice(-1).toUpperCase(); // M, R, A/B

            let orderOptionsHtml = `<strong class="block mb-1">Order for ${unitType} ${unitLocation}:</strong>`;
            orderOptionsHtml += `<div class="flex flex-wrap gap-x-4 gap-y-1">`;

            if (currentPhaseType === 'M' || currentPhaseType === 'S' || currentPhaseType === 'U' || currentPhaseType === 'F') { // Movement Phases (Spring, Summer, Fall)
                orderOptionsHtml += createRadio(`order-type-hold-${unitLocation}`, `order-type-${unitLocation}`, 'Hold', true, '', `order-type-hold-${unitLocation}`);
                orderOptionsHtml += createRadio(`order-type-move-${unitLocation}`, `order-type-${unitLocation}`, 'Move', false, '', `order-type-move-${unitLocation}`);
                orderOptionsHtml += createRadio(`order-type-support-${unitLocation}`, `order-type-${unitLocation}`, 'Support', false, '', `order-type-support-${unitLocation}`);
                if (unitType === 'F') {
                    orderOptionsHtml += createRadio(`order-type-convoy-${unitLocation}`, `order-type-${unitLocation}`, 'Convoy', false, '', `order-type-convoy-${unitLocation}`);
                }
                if (isMachiavelliGame) {
                    orderOptionsHtml += createRadio(`order-type-convert-${unitLocation}`, `order-type-${unitLocation}`, 'Convert', false, '', `order-type-convert-${unitLocation}`);
                    orderOptionsHtml += createRadio(`order-type-besiege-${unitLocation}`, `order-type-${unitLocation}`, 'Besiege', false, '', `order-type-besiege-${unitLocation}`);
                    orderOptionsHtml += createRadio(`order-type-liftsiege-${unitLocation}`, `order-type-${unitLocation}`, 'Lift Siege', false, '', `order-type-liftsiege-${unitLocation}`);
                    if (gameData?.settings?.transform?.move) { // Check if movement phase transforms are allowed
                        orderOptionsHtml += createRadio(`order-type-transform-${unitLocation}`, `order-type-${unitLocation}`, 'Transforms To', false, '', `order-type-transform-${unitLocation}`);
                    }
                }
            } else if (currentPhaseType === 'R') { // Retreat Phase
                orderOptionsHtml += createRadio(`order-type-move-${unitLocation}`, `order-type-${unitLocation}`, 'Retreat To', true, '', `order-type-move-${unitLocation}`); // 'move' action for retreat
                orderOptionsHtml += createRadio(`order-type-disband-${unitLocation}`, `order-type-${unitLocation}`, 'Disband', false, '', `order-type-disband-${unitLocation}`);
                if (isMachiavelliGame) { // Machiavelli retreat by conversion
                     orderOptionsHtml += createRadio(`order-type-convert-${unitLocation}`, `order-type-${unitLocation}`, 'Convert to Garrison', false, '', `order-type-convert-${unitLocation}`);
                }
            } else if (currentPhaseType === 'A' || currentPhaseType === 'B') { // Adjustment/Build Phase
                if (isMachiavelliGame) {
                    orderOptionsHtml += createRadio(`order-type-maintain-${unitLocation}`, `order-type-${unitLocation}`, 'Maintain', true, '', `order-type-maintain-${unitLocation}`);
                    orderOptionsHtml += createRadio(`order-type-remove-${unitLocation}`, `order-type-${unitLocation}`, 'Remove (Disband)', false, '', `order-type-remove-${unitLocation}`);
                    if (gameData?.settings?.transform?.build) { // Check if build phase transforms are allowed
                         orderOptionsHtml += createRadio(`order-type-transformadj-${unitLocation}`, `order-type-${unitLocation}`, 'Transform', false, '', `order-type-transformadj-${unitLocation}`);
                    }
                    // Build is handled separately as it's not tied to an existing unit from the dropdown
                } else { // Standard Diplomacy Build/Remove
                    orderOptionsHtml += createRadio(`order-type-remove-${unitLocation}`, `order-type-${unitLocation}`, 'Remove', false, '', `order-type-remove-${unitLocation}`);
                    // Standard Build is not tied to a unit, so not here.
                }
            }
            orderOptionsHtml += `</div>`;

            // Add specific fields based on order type (initially hidden or shown)
            orderOptionsHtml += `<div id="order-move-details-${unitLocation}" class="mt-2 hidden">`;
            orderOptionsHtml += createInput(`order-move-dest-${unitLocation}`, 'text', 'Destination Province', 'e.g., PAR', false, '', 'Enter 3-letter abbreviation.');
            orderOptionsHtml += createInput(`order-move-coast-${unitLocation}`, 'text', 'Coast (if needed)', 'e.g., NC, SC', false, '', 'Specify /NC, /SC etc.');
            if (unitType === 'A' || (isMachiavelliGame && unitType === 'A')) { // Army move via convoy
                 orderOptionsHtml += createInput(`order-convoy-route-${unitLocation}`, 'text', 'Convoy Route (Army)', 'e.g., NTH-NWY', false, '', 'Enter intermediate sea zones like PROV1-PROV2-DEST.');
            }
            orderOptionsHtml += `</div>`;

            orderOptionsHtml += `<div id="order-support-details-${unitLocation}" class="mt-2 hidden">`;
            orderOptionsHtml += createInput(`order-support-target-unit-${unitLocation}`, 'text', 'Unit Being Supported', 'e.g., A MAR or F BRE', false, '', 'Specify Type and Location.');
            orderOptionsHtml += createInput(`order-support-target-action-${unitLocation}`, 'text', 'Action Being Supported (optional)', 'e.g., - PAR or H', false, '', 'Leave blank for Hold support.');
            orderOptionsHtml += `</div>`;

            if (unitType === 'F') {
                orderOptionsHtml += `<div id="order-convoy-details-${unitLocation}" class="mt-2 hidden">`;
                orderOptionsHtml += createInput(`order-convoy-army-${unitLocation}`, 'text', 'Army Being Convoyed', 'e.g., A LON', false, '', 'Specify Type and Location.');
                orderOptionsHtml += createInput(`order-convoy-dest-${unitLocation}`, 'text', 'Army Destination', 'e.g., NWY', false, '', 'Final destination province.');
                orderOptionsHtml += `</div>`;
            }
            if (isMachiavelliGame) {
                orderOptionsHtml += `<div id="order-convert-details-${unitLocation}" class="mt-2 hidden">`;
                orderOptionsHtml += createSelect(`order-convert-to-type-${unitLocation}`, 'Convert To Type', [{value:'A',text:'Army (A)'},{value:'F',text:'Fleet (F)'},{value:'G',text:'Garrison (G)'},{value:'W',text:'Wing (W)'}], true);
                orderOptionsHtml += createInput(`order-convert-coast-${unitLocation}`, 'text', 'Coast (if Fleet & multi-coastal)', 'e.g., /NC', false);
                orderOptionsHtml += `</div>`;

                if (gameData?.settings?.transform?.move) {
                    orderOptionsHtml += `<div id="order-transform-details-${unitLocation}" class="mt-2 hidden">`;
                    orderOptionsHtml += createSelect(`order-transform-to-type-${unitLocation}`, 'Transform To Type', [{value:'A',text:'Army (A)'},{value:'F',text:'Fleet (F)'},{value:'W',text:'Wing (W)'}], true); // Garrisons not transformed to in move phase
                    orderOptionsHtml += createInput(`order-transform-coast-${unitLocation}`, 'text', 'Coast (if new type is Fleet & multi-coastal)', 'e.g., /NC', false);
                    orderOptionsHtml += `</div>`;
                }
                if (currentPhaseType === 'A' || currentPhaseType === 'B') { // Adjustment phase specific for Machiavelli
                    // Build is separate, not tied to existing unit from dropdown
                    // For transform in adjustment:
                    if (gameData?.settings?.transform?.build) {
                        orderOptionsHtml += `<div id="order-adj-transform-details-${unitLocation}" class="mt-2 hidden">`;
                        orderOptionsHtml += createSelect(`order-adj-transform-to-type-${unitLocation}`, 'Transform To Type', [{value:'A',text:'Army (A)'},{value:'F',text:'Fleet (F)'},{value:'W',text:'Wing (W)'}], true);
                        orderOptionsHtml += createInput(`order-adj-transform-coast-${unitLocation}`, 'text', 'Coast (if new type is Fleet & multi-coastal)', 'e.g., /NC', false);
                        orderOptionsHtml += `</div>`;
                    }
                }
            }


            detailsArea.innerHTML = orderOptionsHtml;

            // Add listeners to the new radio buttons
            detailsArea.querySelectorAll(`input[name="order-type-${unitLocation}"]`).forEach(radio => {
                radio.addEventListener('change', () => handleOrderTypeChange(unitLocation, gameData));
            });
            // Add listeners to the new input fields to update the main command text
             detailsArea.querySelectorAll('input, select').forEach(el => { // Include select
                 el.addEventListener('input', () => updateGeneratedCommandText(window.currentGameData));
                 el.addEventListener('change', () => updateGeneratedCommandText(window.currentGameData)); // For selects
             });
            handleOrderTypeChange(unitLocation, gameData); // Set initial visibility
        }
        updateGeneratedCommandText(window.currentGameData); // Update main text area
    }

    function handleOrderTypeChange(unitLocation, gameData) { // Pass gameData
        const orderTypeFull = radioVal(`order-type-${unitLocation}`);
        if (!orderTypeFull) return;

        const typeParts = orderTypeFull.split('-');
        const orderAction = typeParts[2]; // "move", "hold", "support", etc.
        const isMachiavelliGame = gameData?.settings?.isMachiavelli || gameData?.variant?.toLowerCase().includes('machiavelli');


        qs(`#order-move-details-${unitLocation}`)?.classList.toggle('hidden', orderAction !== 'move');
        qs(`#order-support-details-${unitLocation}`)?.classList.toggle('hidden', orderAction !== 'support');
        qs(`#order-convoy-details-${unitLocation}`)?.classList.toggle('hidden', orderAction !== 'convoy');

        if (isMachiavelliGame) {
            qs(`#order-convert-details-${unitLocation}`)?.classList.toggle('hidden', orderAction !== 'convert');
            qs(`#order-transform-details-${unitLocation}`)?.classList.toggle('hidden', orderAction !== 'transform');
            qs(`#order-adj-transform-details-${unitLocation}`)?.classList.toggle('hidden', orderAction !== 'transformadj');
        }

        updateGeneratedCommandText(window.currentGameData); // Update main text area
    }

    function handleExpenseTypeChange(gameData) {
        const expenseType = val('#expense-type');
        const detailsArea = qs('#expense-details-area');
        if (!detailsArea) return;
        detailsArea.innerHTML = ''; // Clear previous
        detailsArea.classList.toggle('hidden', !expenseType || expenseType === 'NONE');

        if (expenseType && expenseType !== 'NONE') {
            let expenseDetailsHtml = '';
            if (['COUNTER-BRIBE', 'DISBAND', 'BUY', 'GARRISON TO AUTONOMOUS'].includes(expenseType)) {
                expenseDetailsHtml += createSelect('expense-unit-type', 'Unit Type (optional)', [
                    {value:'', text:'Any (A/F/G/W)'}, {value:'A', text:'Army (A)'}, {value:'F', text:'Fleet (F)'},
                    {value:'G', text:'Garrison (G)'}, {value:'W', text:'Wing (W)'}
                ]);
                expenseDetailsHtml += createInput('expense-province', 'text', 'Province', 'e.g., ROM', true);
            } else if (expenseType === 'ASSASSINATE') {
                const powerOptions = gameData?.players?.map(p => ({value: p.power.toUpperCase(), text: p.power})) || [];
                expenseDetailsHtml += createSelect('expense-target-power', 'Target Power', [{value:'', text:'--Select Power--'}, ...powerOptions], true);
            } else if (['FAMINE RELIEF', 'PACIFY REBELLION', 'CAUSE REBELLION'].includes(expenseType)) {
                expenseDetailsHtml += createInput('expense-province', 'text', 'Province', 'e.g., ROM', true);
            }
            detailsArea.innerHTML = expenseDetailsHtml;
            // Add listeners to new inputs
            detailsArea.querySelectorAll('input, select').forEach(el => {
                 el.addEventListener('input', () => updateGeneratedCommandText(window.currentGameData));
                 el.addEventListener('change', () => updateGeneratedCommandText(window.currentGameData));
            });
        }
        updateGeneratedCommandText(window.currentGameData);
    }


    // --- Initial Load ---
    initializeDashboard();

    // --- Add to Command Box Button ---
    const addToCommandBoxBtn = document.getElementById('addToCommandBoxBtn');
    if (addToCommandBoxBtn && generatedCommandTextarea) {
        addToCommandBoxBtn.addEventListener('click', () => {
            // Append instead of overwrite
            if (generatedCommandTextarea.value && !generatedCommandTextarea.value.endsWith('\n')) {
                generatedCommandTextarea.value += '\n';
            }
            generatedCommandTextarea.value += currentGeneratedCommand;
            generatedCommandTextarea.readOnly = false;
            generatedCommandTextarea.focus();
        });
    }

}); // End DOMContentLoaded wrapper