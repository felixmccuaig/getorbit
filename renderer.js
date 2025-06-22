const { desktopCapturer, ipcRenderer } = require('electron');
const { writeFile } = require('fs');
const { dialog, Menu, systemPreferences } = require('@electron/remote');

const videoElement = document.getElementById('video');
const cameraContainer = document.getElementById('camera-container');
const cameraElement = document.getElementById('camera');
const resizeHandle = document.getElementById('resize-handle');
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const videoSelectBtn = document.getElementById('videoSelectBtn');

let mediaRecorder;
const recordedChunks = [];
let screenStream;
let cameraStream;
let combinedStream;
let animationFrameId;

// --- UI State Management ---

function setRecordingUI() {
  ipcRenderer.send('update-controls-ui', {
    isRecording: true,
    pauseDisabled: false,
    pauseText: '❚❚'
  });
  videoSelectBtn.classList.add('hidden');
  cameraContainer.classList.remove('hidden');
}

function setPausedUI() {
  ipcRenderer.send('update-controls-ui', {
    isRecording: true,
    pauseDisabled: false,
    pauseText: '▶'
  });
}

function setResumedUI() {
  ipcRenderer.send('update-controls-ui', {
    isRecording: true,
    pauseDisabled: false,
    pauseText: '❚❚'
  });
}

function setStoppedUI() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  ipcRenderer.send('hide-controls');
  ipcRenderer.send('update-controls-ui', {
    isRecording: false
  });
  videoSelectBtn.classList.remove('hidden');
  cameraContainer.classList.add('hidden');
  videoElement.srcObject = null;
  cameraElement.srcObject = null;
}

// Initial State
setStoppedUI();

// --- Draggable Camera ---
cameraContainer.onmousedown = (e) => {
  e.preventDefault();
  let offsetX = e.clientX - cameraContainer.getBoundingClientRect().left;
  let offsetY = e.clientY - cameraContainer.getBoundingClientRect().top;

  function move(e) {
    cameraContainer.style.left = e.clientX - offsetX + 'px';
    cameraContainer.style.top = e.clientY - offsetY + 'px';
  }

  function up() {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
  }

  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
};

// --- Resizable Camera ---
resizeHandle.onmousedown = (e) => {
  e.preventDefault();
  e.stopPropagation(); // Prevent the container's drag event

  const startSize = cameraContainer.offsetWidth;

  function doResize(e) {
    const scale = (e.clientX - cameraContainer.getBoundingClientRect().left) / startSize;
    const newSize = Math.max(100, startSize * scale); // Enforce a minimum size
    cameraContainer.style.width = newSize + 'px';
    cameraContainer.style.height = newSize + 'px';
  }

  function stopResize() {
    window.removeEventListener('mousemove', doResize);
    window.removeEventListener('mouseup', stopResize);
  }

  window.addEventListener('mousemove', doResize);
  window.addEventListener('mouseup', stopResize);
};


// --- Event Handlers ---
videoSelectBtn.onclick = getVideoSources;

ipcRenderer.on('control-action', (event, data) => {
  switch (data.type) {
    case 'start':
      startRecording(data.cameraId, data.micId);
      break;
    case 'pause':
      if (mediaRecorder.state === 'recording') {
        mediaRecorder.pause();
        setPausedUI();
      } else if (mediaRecorder.state === 'paused') {
        mediaRecorder.resume();
        setResumedUI();
      }
      break;
    case 'stop':
      if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
      }
      break;
  }
});

// Handle direct recording start from controls
ipcRenderer.on('select-source-and-record', async (event, data) => {
  try {
    // Hide the select button since we're starting directly
    videoSelectBtn.classList.add('hidden');
    
    // Find the source by ID
    const sources = await ipcRenderer.invoke('get-sources');
    const selectedSource = sources.find(source => source.id === data.windowId);
    
    if (selectedSource) {
      // Select the source first
      await selectSource(selectedSource);
      
      // Wait a bit for the source to be ready, then start recording
      setTimeout(() => {
        startRecording(data.cameraId, data.micId);
      }, 1000);
    } else {
      console.error('Source not found:', data.windowId);
    }
  } catch (error) {
    console.error('Error starting recording:', error);
  }
});


// --- Core Logic ---

async function getVideoSources() {
  // macOS permission check
  if (process.platform === 'darwin') {
    const status = systemPreferences.getMediaAccessStatus('screen');
    if (status !== 'granted') {
      const granted = await systemPreferences.askForMediaAccess('screen').catch(() => false);
      if (!granted) {
        const { response } = await dialog.showMessageBox({
          type: 'warning',
          title: 'Permission Required',
          message: 'Screen recording permission is required.',
          detail: 'Please grant permission in System Settings > Privacy & Security > Screen Recording. Orbit must be restarted for the change to take effect.',
          buttons: ['OK', 'Quit and Relaunch'],
          defaultId: 1
        });

        if (response === 1) { // Relaunch button clicked
          ipcRenderer.send('relaunch-app');
        }
        return;
      } else {
        console.log('Screen recording permission is granted.');
      }
    }
  }

  const inputSources = await ipcRenderer.invoke('get-sources');

  const videoOptionsMenu = Menu.buildFromTemplate(
    inputSources.map(source => ({
      label: source.name,
      click: () => selectSource(source)
    }))
  );
  videoOptionsMenu.popup();
}

async function selectSource(source) {
  try {
    videoSelectBtn.innerText = 'Select another source';
    videoSelectBtn.classList.remove('hidden');

    screenStream = await navigator.mediaDevices.getUserMedia({
      audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: source.id } }
    });

    // Get available cameras and microphones
    const devices = await navigator.mediaDevices.enumerateDevices();
    const videoDevices = devices.filter(d => d.kind === 'videoinput');
    const audioDevices = devices.filter(d => d.kind === 'audioinput');
    ipcRenderer.send('set-control-devices', { video: videoDevices, audio: audioDevices });
    
    // Use the first camera by default for the preview
    cameraStream = await navigator.mediaDevices.getUserMedia({ 
      video: { deviceId: { exact: videoDevices[0].deviceId } }, 
      audio: false 
    });
    
    videoElement.srcObject = screenStream;
    videoElement.play();
    cameraElement.srcObject = cameraStream;
    cameraElement.play();

    // Wait for videos to load metadata to get correct dimensions
    videoElement.onloadedmetadata = () => {
      canvas.width = videoElement.videoWidth;
      canvas.height = videoElement.videoHeight;
      drawStreams();
    };
    
    ipcRenderer.send('show-controls');
    ipcRenderer.send('update-controls-ui', { isRecording: false });
    cameraContainer.classList.remove('hidden');
    videoSelectBtn.classList.add('hidden'); // Hide after selection

  } catch (e) {
    console.error('Error selecting source:', e);
    alert('Could not select the source. Please ensure permissions are granted and try again.');
    setStoppedUI();
  }
}

function drawStreams() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  
  // Draw screen video
  ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);

  // Draw camera video
  const cameraRect = cameraContainer.getBoundingClientRect();
  const videoRect = videoElement.getBoundingClientRect();

  // Calculate position relative to the video element
  const cameraX = cameraRect.left - videoRect.left;
  const cameraY = cameraRect.top - videoRect.top;
  
  // --- Cropping logic to prevent squishing ---
  const camVideo = cameraElement;
  const targetWidth = cameraRect.width;
  const targetHeight = cameraRect.height;

  const videoRatio = camVideo.videoWidth / camVideo.videoHeight;
  const targetRatio = targetWidth / targetHeight;

  let sx, sy, sWidth, sHeight;

  if (videoRatio > targetRatio) {
    // Video is wider than target, crop horizontally
    sHeight = camVideo.videoHeight;
    sWidth = sHeight * targetRatio;
    sx = (camVideo.videoWidth - sWidth) / 2;
    sy = 0;
  } else {
    // Video is taller than target, crop vertically
    sWidth = camVideo.videoWidth;
    sHeight = sWidth / targetRatio;
    sx = 0;
    sy = (camVideo.videoHeight - sHeight) / 2;
  }
  // --- End cropping logic ---
  
  // Create a circular clipping path
  ctx.save();
  ctx.beginPath();
  ctx.arc(cameraX + targetWidth / 2, cameraY + targetHeight / 2, targetWidth / 2, 0, Math.PI * 2);
  ctx.clip();
  
  ctx.drawImage(camVideo, sx, sy, sWidth, sHeight, cameraX, cameraY, targetWidth, targetHeight);

  // Restore the context to remove the clipping path for the next frame
  ctx.restore();

  animationFrameId = requestAnimationFrame(drawStreams);
}

async function startRecording(cameraId, micId) {
  try {
    const videoConstraints = {
      deviceId: { exact: cameraId }
    };
    const audioConstraints = {
      deviceId: { exact: micId }
    };
  
    // Get the correct camera and mic streams
    const finalCameraStream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints, audio: false });
    const finalAudioStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });

    cameraElement.srcObject = finalCameraStream; // Update preview to selected camera

    const videoTrack = screenStream.getVideoTracks()[0];
    const audioTrack = finalAudioStream.getAudioTracks()[0];
    if (!videoTrack || !audioTrack) {
      alert('A valid video and audio track are required.');
      return;
    }

    // Create a combined stream from the canvas and the camera's audio
    const canvasStream = canvas.captureStream(30); // 30 FPS
    combinedStream = new MediaStream([
      canvasStream.getVideoTracks()[0],
      audioTrack
    ]);

    recordedChunks.length = 0;
    
    const options = { mimeType: 'video/webm; codecs=vp9' };
    mediaRecorder = new MediaRecorder(combinedStream, options);

    mediaRecorder.ondataavailable = handleDataAvailable;
    mediaRecorder.onstop = handleStop;

    mediaRecorder.start();
    setRecordingUI();
  } catch (e) {
    console.error('Error starting recording:', e);
    alert('Could not start recording. Please check your selected devices.');
    setStoppedUI();
  }
}

function handleDataAvailable(e) {
  if (e.data.size > 0) {
    recordedChunks.push(e.data);
  }
}

async function handleStop() {
  if (animationFrameId) {
    cancelAnimationFrame(animationFrameId);
    animationFrameId = null;
  }
  const blob = new Blob(recordedChunks, { type: 'video/webm; codecs=vp9' });
  const buffer = Buffer.from(await blob.arrayBuffer());

  const { filePath } = await dialog.showSaveDialog({
    buttonLabel: 'Save Video', defaultPath: `vid-${Date.now()}.webm`
  });

  if (filePath) {
    writeFile(filePath, buffer, () => console.log('Video saved successfully!'));
  }

  setStoppedUI();
} 