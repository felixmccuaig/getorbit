const { app, BrowserWindow, ipcMain, Menu, desktopCapturer, Tray } = require('electron');
const path = require('path');

require('@electron/remote/main').initialize();

let tray;
let controlsWindow;
let windowSelectorWindow;
let cameraWindow;
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

ipcMain.on('window-selected', (event, windowData) => {
  // Forward the selection back to the controls window
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('window-selected', windowData);
  }
  // Hide the selector window
  if (windowSelectorWindow && !windowSelectorWindow.isDestroyed()) {
    windowSelectorWindow.hide();
  }
});

ipcMain.on('recording-started', () => {
  isRecording = true;
  // Update controls UI to show recording state
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('recording-state-changed', { isRecording: true });
  }
});

ipcMain.on('recording-stopped', () => {
  isRecording = false;
  // Update controls UI to show stopped state
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('recording-state-changed', { isRecording: false });
  }
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
    
    // Send shutdown signal to camera window to stop all streams
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

function startRecording(data) {
  console.log('Starting recording with data:', data);
  recordingData = data;
  isRecording = true;
  
  // Create camera window if it doesn't exist
  if (!cameraWindow) {
    createCameraWindow();
  }
  
  // Make sure camera window is ready before sending events
  if (cameraWindow.webContents.isLoading()) {
    cameraWindow.webContents.once('did-finish-load', () => {
      console.log('Camera window loaded, starting recording...');
      startRecordingProcess(data);
    });
  } else {
    startRecordingProcess(data);
  }
}

function startRecordingProcess(data) {
  // Show camera and start recording
  cameraWindow.show();
  
  // First update camera to selected one
  cameraWindow.webContents.send('start-camera', {
    cameraId: data.cameraId
  });
  
  // Then start the recording process
  setTimeout(() => {
    cameraWindow.webContents.send('start-recording', {
      windowId: data.windowId,
      cameraId: data.cameraId,
      micId: data.micId
    });
  }, 500); // Small delay to ensure camera is ready
}

function stopRecording() {
  console.log('Stopping recording...');
  isRecording = false;
  
  if (cameraWindow && !cameraWindow.isDestroyed()) {
    // Send stop recording command to camera window
    cameraWindow.webContents.send('stop-recording');
    
    // Hide camera window after recording stops
    cameraWindow.hide();
  }
  
  // Update controls UI to show stopped state
  if (controlsWindow && !controlsWindow.isDestroyed()) {
    controlsWindow.webContents.send('recording-state-changed', { isRecording: false });
  }
  
  recordingData = null;
  console.log('Recording stopped and cleaned up');
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
});