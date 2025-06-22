const { app, BrowserWindow, ipcMain, Menu, desktopCapturer, Tray } = require('electron');
const path = require('path');
const { windowManager } = require('node-window-manager');

require('@electron/remote/main').initialize();

let tray;
let controlsWindow;
let windowSelectorWindow;
let cameraWindow;
let recordingWindow;
let isRecording = false;
let recordingData = null;

ipcMain.on('relaunch-app', () => {
  app.relaunch();
  app.quit();
});

ipcMain.handle('get-sources', async () => {
  return desktopCapturer.getSources({ types: ['window', 'screen'] });
});

ipcMain.handle('get-screen-dimensions', async () => {
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  return primaryDisplay.bounds;
});

ipcMain.on('show-controls', () => {
  if (controlsWindow) {
    controlsWindow.show();
    controlsWindow.focus();
  }
  
  // Also show camera window when controls are shown
  if (!cameraWindow) {
    createCameraWindow();
  }
  cameraWindow.show();
});

ipcMain.on('control-event', (event, action) => {
  console.log('Control event:', action);
  
  if (action.type === 'start') {
    // Start recording with floating camera
    startRecording(action);
  } else if (action.type === 'stop') {
    // Stop recording
    stopRecording();
  } else if (action.type === 'pause') {
    // Pause/resume recording
    if (cameraWindow) {
      cameraWindow.webContents.send('pause-recording');
    }
  }
});

ipcMain.on('show-window-selector', () => {
  if (!windowSelectorWindow || windowSelectorWindow.isDestroyed()) {
    createWindowSelectorWindow();
  }
  
  // Position initially
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    const [x, y] = controlsWindow.getPosition();
    const [width] = controlsWindow.getSize();
    windowSelectorWindow.setBounds({
      x: x + width + 10,
      y: y,
      width: windowSelectorWindow.getBounds().width,
      height: windowSelectorWindow.getBounds().height
    });
  }
  
  windowSelectorWindow.show();
  windowSelectorWindow.focus();
});

ipcMain.on('hide-window-selector', () => {
  if (windowSelectorWindow && !windowSelectorWindow.isDestroyed()) {
    windowSelectorWindow.hide();
  }
});

ipcMain.on('window-selected', async (event, windowData) => {
  console.log('Window selected:', windowData);
  
  // Forward the selection back to the controls window
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('window-selected', windowData);
  }
  
  // Hide the selector window
  if (windowSelectorWindow && !windowSelectorWindow.isDestroyed()) {
    windowSelectorWindow.hide();
  }
  
  // Immediately show the recording outline around the selected window
  await showRecordingOutline(windowData);
});

ipcMain.on('recording-started', () => {
  isRecording = true;
  // Update controls UI to show recording state
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('recording-state-changed', { isRecording: true });
  }
});

ipcMain.on('recording-stopped', () => {
  console.log('Recording stopped event received from recording overlay');
  isRecording = false;
  recordingData = null;
  
  // Hide recording overlay after recording stops
  if (recordingWindow && !recordingWindow.isDestroyed()) {
    recordingWindow.hide();
  }
  
  // Update controls UI to show stopped state
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('recording-state-changed', { isRecording: false });
  }
  
  console.log('Area recording stopped and cleaned up');
});

// Handle user stopping recording from within the recording overlay
ipcMain.on('user-stop-recording', () => {
  console.log('User requested stop recording from recording overlay');
  stopRecording();
});

// Handle recording errors
ipcMain.on('recording-error', (event, errorMessage) => {
  console.error('Recording error:', errorMessage);
  isRecording = false;
  recordingData = null;
  
  // Hide recording overlay
  if (recordingWindow && !recordingWindow.isDestroyed()) {
    recordingWindow.hide();
  }
  
  // Update controls UI to show stopped state
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('recording-state-changed', { isRecording: false });
  }
});

// Handle recording saved successfully
ipcMain.on('recording-saved', (event, filePath) => {
  console.log('Recording saved successfully to:', filePath);
});

// Handle camera position updates from recording area drag/resize
ipcMain.on('update-camera-position', (event, bounds) => {
  moveCameraToRecordingArea(bounds);
});

function createTray() {
  try {
    // Use PNG file for better compatibility with system tray
    tray = new Tray(path.join(__dirname, 'orbit.png'));
    
    console.log('Tray created successfully');
    
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Open Orbit',
        click: () => {
          if (!controlsWindow) {
            createControlsWindow();
          }
          controlsWindow.show();
          controlsWindow.focus();
        }
      },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        }
      }
    ]);
    
    tray.setContextMenu(contextMenu);
    tray.setToolTip('Orbit Screen Recorder');
    
            tray.on('click', () => {
      console.log('Tray clicked');
      if (!controlsWindow || controlsWindow.isDestroyed()) {
        createControlsWindow();
      }
      if (controlsWindow.isVisible()) {
        controlsWindow.hide();
        // Also hide camera window when controls are hidden (unless recording)
        if (cameraWindow && !cameraWindow.isDestroyed() && !isRecording) {
          cameraWindow.hide();
        }
      } else {
        controlsWindow.show();
        controlsWindow.focus();
        
        // Also show camera window when controls are shown
        if (!cameraWindow || cameraWindow.isDestroyed()) {
          createCameraWindow();
        } else {
          // If camera window exists but was hidden, restart camera preview
          cameraWindow.webContents.send('restart-camera-preview');
        }
        cameraWindow.show();
      }
    });
  } catch (error) {
    console.error('Failed to create tray:', error);
    console.error('Falling back to showing controls window directly');
    // Fallback: create and show the controls window directly
    if (!controlsWindow) {
      createControlsWindow();
    }
    controlsWindow.show();
    controlsWindow.focus();
  }
}

function createControlsWindow() {
  controlsWindow = new BrowserWindow({
    width: 400,
    height: 500,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  require('@electron/remote/main').enable(controlsWindow.webContents);
  controlsWindow.loadFile('controls.html');
  
  // Clean up reference when window is closed/destroyed
  controlsWindow.on('closed', () => {
    controlsWindow = null;
  });
  
  // Don't auto-hide on blur - let user control when to close
  controlsWindow.on('close', (event) => {
    event.preventDefault();
    
    console.log('Controls window close event triggered');
    
    // Stop any active recording
    if (isRecording) {
      console.log('Stopping active recording due to controls close');
      stopRecording();
    }
    
    // Close the recording overlay if it's open
    if (recordingWindow && !recordingWindow.isDestroyed()) {
      recordingWindow.close();
    }
    
    // Send shutdown signal to camera window to stop all streams (for preview mode)
    if (cameraWindow && !cameraWindow.isDestroyed()) {
      cameraWindow.webContents.send('controls-closing');
    }
    
    // Close the window selector if it's open
    if (windowSelectorWindow && !windowSelectorWindow.isDestroyed()) {
      windowSelectorWindow.close();
    }
    
    // Hide the camera window when controls are closed
    if (cameraWindow && !cameraWindow.isDestroyed()) {
      cameraWindow.hide();
    }
    
    controlsWindow.hide();
  });
}

function createWindowSelectorWindow() {
  windowSelectorWindow = new BrowserWindow({
    width: 600,
    height: 600,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    resizable: false,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  require('@electron/remote/main').enable(windowSelectorWindow.webContents);
  windowSelectorWindow.loadFile('windowSelector.html');
  
  // Clean up reference when window is closed/destroyed
  windowSelectorWindow.on('closed', () => {
    windowSelectorWindow = null;
  });
  
  // Set up smooth window following
  setupWindowFollowing();
}

function setupWindowFollowing() {
  if (!controlsWindow || controlsWindow.isDestroyed()) return;
  
  let lastUpdate = 0;
  const throttleMs = 16; // ~60fps
  
  const updateSelectorPosition = () => {
    // Check if windows still exist and are not destroyed
    if (!windowSelectorWindow || windowSelectorWindow.isDestroyed() || !windowSelectorWindow.isVisible()) return;
    if (!controlsWindow || controlsWindow.isDestroyed()) return;
    
    const now = Date.now();
    if (now - lastUpdate < throttleMs) return;
    lastUpdate = now;
    
    try {
      const [x, y] = controlsWindow.getPosition();
      const [width] = controlsWindow.getSize();
      const selectorBounds = windowSelectorWindow.getBounds();
      
      // Only update if position actually changed
      const newX = x + width + 10;
      const newY = y;
      
      if (selectorBounds.x !== newX || selectorBounds.y !== newY) {
        windowSelectorWindow.setBounds({
          x: newX,
          y: newY,
          width: selectorBounds.width,
          height: selectorBounds.height
        });
      }
    } catch (error) {
      console.error('Error updating selector position:', error);
    }
  };
  
  // Use both move events for better coverage
  controlsWindow.on('move', updateSelectorPosition);
  controlsWindow.on('moved', updateSelectorPosition);
  
  // Also listen for resize in case it affects positioning
  controlsWindow.on('resize', updateSelectorPosition);
}

function createCameraWindow() {
  cameraWindow = new BrowserWindow({
    width: 200,
    height: 200,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  require('@electron/remote/main').enable(cameraWindow.webContents);
  cameraWindow.loadFile('camera.html');
  
  // Position in bottom right initially
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  cameraWindow.setPosition(width - 220, height - 220);
  
  // Start camera preview once window is loaded
  cameraWindow.webContents.once('did-finish-load', () => {
    cameraWindow.webContents.send('start-preview');
  });
  
  cameraWindow.on('closed', () => {
    cameraWindow = null;
  });
  
  return cameraWindow;
}

function createRecordingWindow() {
  const { screen } = require('electron');
  const displays = screen.getAllDisplays();
  const union = displays.reduce((acc, d) => {
    const b = d.bounds;
    const minX = Math.min(acc.minX, b.x);
    const minY = Math.min(acc.minY, b.y);
    const maxX = Math.max(acc.maxX, b.x + b.width);
    const maxY = Math.max(acc.maxY, b.y + b.height);
    return { minX, minY, maxX, maxY };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

  const totalWidth = union.maxX - union.minX;
  const totalHeight = union.maxY - union.minY;

  recordingWindow = new BrowserWindow({
    width: totalWidth,
    height: totalHeight,
    x: union.minX,
    y: union.minY,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    show: false,
    fullscreen: false,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    }
  });

  require('@electron/remote/main').enable(recordingWindow.webContents);
  recordingWindow.loadFile('recordingWindow.html');
  
  recordingWindow.on('closed', () => {
    recordingWindow = null;
  });
  
  return recordingWindow;
}

async function getActualWindowBounds(windowData) {
  try {
    // Try using node-window-manager for precise bounds
    const winIdMatch = windowData.id.match(/window:(\d+):/);
    let targetBounds = null;
    if (winIdMatch) {
      const nativeId = parseInt(winIdMatch[1], 10);
      const allWins = windowManager.getWindows();
      const targetWin = allWins.find(w => w.id === nativeId);
      if (targetWin) {
        const b = targetWin.getBounds();
        // node-window-manager already returns coordinates with origin at top-left
        targetBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
        // Keep negative coordinates (secondary displays) as-is
      }
    }

    // Fallback: if it's a full screen capture (screen:id)
    if (!targetBounds && windowData.id.startsWith('screen')) {
      const displayId = windowData.id.split(':')[1];
      const { screen } = require('electron');
      const displays = screen.getAllDisplays();
      const targetDisplay = displays.find(d => d.id.toString() === displayId);
      if (targetDisplay) {
        targetBounds = {
          x: targetDisplay.bounds.x,
          y: targetDisplay.bounds.y,
          width: targetDisplay.bounds.width,
          height: targetDisplay.bounds.height,
        };
      }
    }

    if (targetBounds) return targetBounds;
  } catch (e) {
    console.warn('node-window-manager bounds failed:', e.message);
  }
  // Fallback smart estimate (center of primary display)
  const { screen } = require('electron');
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width, height } = primaryDisplay.workAreaSize;
  const windowWidth = Math.min(Math.floor(width * 0.6), 1200);
  const windowHeight = Math.min(Math.floor(height * 0.7), 800);
  return {
    x: Math.floor((width - windowWidth) / 2),
    y: Math.floor((height - windowHeight) / 2),
    width: windowWidth,
    height: windowHeight,
  };
}

async function showRecordingOutline(windowData) {
  console.log('Showing recording outline for:', windowData);
  
  // Create recording window if needed
  if (!recordingWindow || recordingWindow.isDestroyed()) {
    console.log('Creating new recording window for outline...');
    createRecordingWindow();
  }
  
  // Get the actual bounds of the selected window
  const bounds = await getActualWindowBounds(windowData);
  console.log('Using bounds for outline:', bounds);
  
  // Show recording window and position outline
  recordingWindow.show();
  
  // Move the existing camera window to the recording area
  moveCameraToRecordingArea(bounds);
  
  const sendOutlineEvents = () => {
    console.log('Sending outline positioning to recording window');
    recordingWindow.webContents.send('position-recording-area', bounds);
    recordingWindow.webContents.send('show-outline-only'); // New event to show just outline
  };
  
  if (recordingWindow.webContents.isLoading()) {
    recordingWindow.webContents.once('did-finish-load', sendOutlineEvents);
  } else {
    sendOutlineEvents();
  }
}

function moveCameraToRecordingArea(bounds) {
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    const camBounds = cameraWindow.getBounds();
    const cameraSize = Math.min(camBounds.width, camBounds.height);
    const margin = 20;
    const cameraX = bounds.x + bounds.width - cameraSize - margin;
    const cameraY = bounds.y + bounds.height - cameraSize - margin;
    cameraWindow.setBounds({ x: cameraX, y: cameraY, width: cameraSize, height: cameraSize });
    cameraWindow.show();
  } else {
    console.log('Camera window not available to move');
  }
}

function startScreenRecording(data) {
  console.log('Starting screen recording with data:', data);
  recordingData = data;
  isRecording = true;
  
  // Recording window should already exist and be positioned from window selection
  if (!recordingWindow || recordingWindow.isDestroyed()) {
    console.log('Error: Recording window should already exist when starting recording');
    return;
  }
  
  // Just send the start recording command - outline should already be positioned
  console.log('Sending start recording command to existing positioned window');
  recordingWindow.webContents.send('start-recording', data);
  
  // Update controls UI to show recording state
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('recording-state-changed', { isRecording: true });
  }
  
  console.log('Screen recording started');
}

function startRecording(data) {
  console.log('Starting recording with data:', data);
  startScreenRecording(data);
}

// Removed getWindowBounds and startAreaRecordingProcess - no longer needed

function stopRecording() {
  console.log('Stopping recording...');
  
  if (isRecording) {
    // Send stop command to recording window
    if (recordingWindow && !recordingWindow.isDestroyed()) {
      recordingWindow.webContents.send('stop-recording');
    }
    
    isRecording = false;
    recordingData = null;
    
    // Update controls UI to show stopped state
    if (controlsWindow && !controlsWindow.isDestroyed()) {
      controlsWindow.webContents.send('recording-state-changed', { isRecording: false });
    }
    
    console.log('Recording stopped');
  }
}

// Request macOS accessibility permission (no-op on Windows)
try {
  windowManager.requestAccessibility && windowManager.requestAccessibility();
} catch (err) {
  console.warn('windowManager accessibility request failed:', err?.message);
}

app.whenReady().then(() => {
  console.log('App is ready, creating tray...');
  
  // Don't show dock icon on macOS (do this before creating tray)
  if (process.platform === 'darwin') {
    console.log('Hiding dock icon on macOS');
    app.dock.hide();
  }
  
  createTray();
  console.log('App initialization complete');
}).catch((error) => {
  console.error('Failed to initialize app:', error);
});

app.on('window-all-closed', (e) => {
  // Prevent app from quitting when all windows are closed (system tray app)
  e.preventDefault();
  console.log('All windows closed, but keeping app running in tray');
});

app.on('before-quit', () => {
  if (tray) {
    tray.destroy();
  }
  if (windowSelectorWindow) {
    windowSelectorWindow.destroy();
  }
  if (cameraWindow) {
    cameraWindow.destroy();
  }
  if (recordingWindow) {
    recordingWindow.destroy();
  }
});