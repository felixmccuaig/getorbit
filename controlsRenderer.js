const { ipcRenderer } = require('electron');

// UI Elements
const closeBtn = document.getElementById('close-btn');
const windowSection = document.getElementById('window-section');
const windowHeader = document.getElementById('window-header');
const windowLabel = document.getElementById('window-label');
const cameraSection = document.getElementById('camera-section');
const cameraList = document.getElementById('camera-list');
const cameraStatus = document.getElementById('camera-status');
const micSection = document.getElementById('mic-section');
const micList = document.getElementById('mic-list');
const micStatus = document.getElementById('mic-status');
const startBtn = document.getElementById('start-recording');
const stopBtn = document.getElementById('stop-recording');

// State
let selectedWindow = null;
let selectedCamera = null;
let selectedMic = null;
let availableWindows = [];
let availableCameras = [];
let availableMics = [];

// Event Handlers
closeBtn.onclick = () => {
    window.close();
};

windowHeader.onclick = () => {
    // Show the window selector popup instead of dropdown
    ipcRenderer.send('show-window-selector');
};

cameraSection.onclick = () => {
    if (availableCameras.length > 0) {
        cameraList.classList.toggle('hidden');
        micList.classList.add('hidden');
    }
};

micSection.onclick = () => {
    if (availableMics.length > 0) {
        micList.classList.toggle('hidden');
        cameraList.classList.add('hidden');
    }
};

let isRecording = false;
let isPaused = false;

startBtn.onclick = () => {
    if (!isRecording) {
        // Start recording
        if (selectedWindow && selectedCamera && selectedMic) {
            ipcRenderer.send('control-event', {
                type: 'start',
                windowId: selectedWindow,
                cameraId: selectedCamera,
                micId: selectedMic
            });
        }
    } else if (isPaused) {
        // Resume recording
        ipcRenderer.send('control-event', { type: 'pause' });
        isPaused = false;
        updateRecordingUI();
    } else {
        // Pause recording
        ipcRenderer.send('control-event', { type: 'pause' });
        isPaused = true;
        updateRecordingUI();
    }
};

stopBtn.onclick = () => {
    ipcRenderer.send('control-event', { type: 'stop' });
};

// Initialize the interface
async function initialize() {
    try {
        // Get available windows/screens (not needed for inline list anymore)
        const sources = await ipcRenderer.invoke('get-sources');
        availableWindows = sources;

        // Get available cameras and microphones
        const devices = await navigator.mediaDevices.enumerateDevices();
        availableCameras = devices.filter(d => d.kind === 'videoinput');
        availableMics = devices.filter(d => d.kind === 'audioinput');
        
        // Auto-select default camera and microphone
        if (availableCameras.length > 0) {
            selectedCamera = availableCameras[0].deviceId;
        }
        if (availableMics.length > 0) {
            selectedMic = availableMics[0].deviceId;
        }
        
        populateCameraList();
        populateMicList();
        updateUI();
    } catch (error) {
        console.error('Error initializing:', error);
    }
}



function populateCameraList() {
    cameraList.innerHTML = '';
    
    availableCameras.forEach(device => {
        const item = document.createElement('div');
        item.className = 'option-item';
        item.innerHTML = `
            <span class="icon">📹</span>
            <span class="label">${device.label || `Camera ${availableCameras.indexOf(device) + 1}`}</span>
        `;
        
        item.onclick = () => {
            // Remove previous selection
            cameraList.querySelectorAll('.option-item').forEach(el => el.classList.remove('selected'));
            // Select this item
            item.classList.add('selected');
            selectedCamera = device.deviceId;
            cameraList.classList.add('hidden');
            updateUI();
        };
        
        // Pre-select if this is the default camera
        if (device.deviceId === selectedCamera) {
            item.classList.add('selected');
        }
        
        cameraList.appendChild(item);
    });
}

function populateMicList() {
    micList.innerHTML = '';
    
    availableMics.forEach(device => {
        const item = document.createElement('div');
        item.className = 'option-item';
        item.innerHTML = `
            <span class="icon">🎤</span>
            <span class="label">${device.label || `Microphone ${availableMics.indexOf(device) + 1}`}</span>
        `;
        
        item.onclick = () => {
            // Remove previous selection
            micList.querySelectorAll('.option-item').forEach(el => el.classList.remove('selected'));
            // Select this item
            item.classList.add('selected');
            selectedMic = device.deviceId;
            micList.classList.add('hidden');
            updateUI();
        };
        
        // Pre-select if this is the default microphone
        if (device.deviceId === selectedMic) {
            item.classList.add('selected');
        }
        
        micList.appendChild(item);
    });
}

function updateUI() {
    // Update camera status and label
    const cameraLabel = document.querySelector('#camera-section .label');
    if (selectedCamera) {
        const selectedCameraDevice = availableCameras.find(d => d.deviceId === selectedCamera);
        const cameraName = selectedCameraDevice ? (selectedCameraDevice.label || 'Camera') : 'Camera';
        cameraLabel.textContent = cameraName;
        cameraStatus.textContent = 'On';
        cameraStatus.classList.remove('off');
    } else {
        cameraLabel.textContent = 'Camera';
        cameraStatus.textContent = 'Off';
        cameraStatus.classList.add('off');
    }
    
    // Update mic status and label
    const micLabel = document.querySelector('#mic-section .label');
    if (selectedMic) {
        const selectedMicDevice = availableMics.find(d => d.deviceId === selectedMic);
        const micName = selectedMicDevice ? (selectedMicDevice.label || 'Microphone') : 'Microphone';
        micLabel.textContent = micName;
        micStatus.textContent = 'On';
        micStatus.classList.remove('off');
    } else {
        micLabel.textContent = 'Microphone';
        micStatus.textContent = 'Off';
        micStatus.classList.add('off');
    }
    
    // Update start button
    startBtn.disabled = !(selectedWindow && selectedCamera && selectedMic);
}

function updateRecordingUI() {
    if (isRecording) {
        startBtn.textContent = isPaused ? 'Resume' : 'Pause';
        startBtn.classList.remove('hidden');
        stopBtn.classList.remove('hidden');
        startBtn.disabled = false;
    } else {
        startBtn.textContent = 'Start recording';
        startBtn.classList.remove('hidden');
        stopBtn.classList.add('hidden');
        isPaused = false;
        updateUI(); // Refresh start button state
    }
}

// Hide dropdown lists when clicking outside
document.addEventListener('click', (e) => {
    if (!cameraSection.contains(e.target)) {
        cameraList.classList.add('hidden');
    }
    if (!micSection.contains(e.target)) {
        micList.classList.add('hidden');
    }
});

// Listen for window selection from the popup
ipcRenderer.on('window-selected', (event, windowData) => {
    selectedWindow = windowData.id;
    windowLabel.textContent = windowData.name;
    updateUI();
});

// Listen for recording state changes
ipcRenderer.on('recording-state-changed', (event, data) => {
    isRecording = data.isRecording;
    updateRecordingUI();
});

// Handle window closing while recording
window.addEventListener('beforeunload', (e) => {
    if (isRecording) {
        console.log('Controls window closing while recording - stopping recording');
        // Stop recording before closing
        ipcRenderer.send('control-event', { type: 'stop' });
    }
});

// Initialize when the page loads
window.onload = initialize; 