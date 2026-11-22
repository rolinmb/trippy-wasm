async function init() {
    // --------------------------------------------------
    // DOM ELEMENTS
    // --------------------------------------------------

    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d", {
        alpha: true
    });

    const appStatus = document.getElementById("app-status");

    const applicationMode = document.getElementById("application-mode");
    const modeDescription = document.getElementById("mode-description");

    const generationPanel = document.querySelector(".generation-panel");

    const generateBtn = document.getElementById("generate-btn");

    const pictureDownloadPanel = document.getElementById(
        "picture-download-panel"
    );

    const downloadImgBtn = document.getElementById("download-img-btn");
    const filenameInput = document.getElementById("filename");
    const formatSelect = document.getElementById("image-format");

    const animationPanel = document.getElementById("animation-panel");

    const animationFps = document.getElementById("animation-fps");
    const animationDuration = document.getElementById("animation-duration");
    const animationLoopCheckbox = document.getElementById("animation-loop");

    const fpsValue = document.getElementById("fps-value");
    const durationValue = document.getElementById("duration-value");

    const playAnimationBtn = document.getElementById("play-animation-btn");
    const stopAnimationBtn = document.getElementById("stop-animation-btn");
    const recordAnimationBtn = document.getElementById("record-animation-btn");

    const animationStatus = document.getElementById("animation-status");

    const animationFilename = document.getElementById("animation-filename");
    const animationFormat = document.getElementById("animation-format");

    const downloadAnimationBtn = document.getElementById(
        "download-animation-btn"
    );

    const widthSlider = document.getElementById("canvas-width");
    const heightSlider = document.getElementById("canvas-height");

    const widthValue = document.getElementById("width-value");
    const heightValue = document.getElementById("height-value");

    const expressionInputs = [
        document.getElementById("r-expression"),
        document.getElementById("g-expression"),
        document.getElementById("b-expression"),
        document.getElementById("a-expression")
    ];

    // --------------------------------------------------
    // DEFAULT EXPRESSIONS
    // --------------------------------------------------

    const defaultExpressions = [
        "sin(x * 0.02) * 127 + 128",
        "cos(y * 0.02) * 127 + 128",
        "sin((x + y) * 0.01) * 127 + 128",
        "255"
    ];

    expressionInputs.forEach((input, index) => {
        if (!input.value.trim()) {
            input.value = defaultExpressions[index];
        }
    });

    // --------------------------------------------------
    // APPLICATION STATE
    // --------------------------------------------------

    let wasm = null;
    let memory = null;

    let hasGeneratedImage = false;

    let isAnimating = false;
    let isRecording = false;

    let animationFrameId = null;
    let recordingTimeout = null;

    let animationStartTime = 0;
    let lastFrameTime = 0;

    let recordedAnimationBlob = null;
    let mediaRecorder = null;
    let recordedChunks = [];
    let animationStream = null;

    let lastAnimationError = null;

    // --------------------------------------------------
    // STATUS HELPERS
    // --------------------------------------------------

    function setAppStatus(message) {
        appStatus.textContent = message;
    }

    function setAnimationStatus(message) {
        animationStatus.textContent = message;
    }

    function setError(error) {
        console.error(error);

        setAppStatus(`Error: ${error.message}`);
        setAnimationStatus(`Error: ${error.message}`);
    }

    // --------------------------------------------------
    // LOAD WEBASSEMBLY
    // --------------------------------------------------

    async function loadWasm() {

        const response = await fetch("./wasm/app.wasm");

        if (!response.ok) {
            throw new Error(
                `Failed to load app.wasm: HTTP ${response.status}`
            );
        }

        const wasmBytes = await response.arrayBuffer();

        const imports = {
            env: {
                sin: Math.sin,
                cos: Math.cos,
                tan: Math.tan,
                exp: Math.exp,
                sqrt: Math.sqrt,
                abs: Math.abs,
                pow: Math.pow
            }
        };

        const result = await WebAssembly.instantiate(
            wasmBytes,
            imports
        );

        wasm = result.instance.exports;
        memory = wasm.memory;

        // Validate the expected WASM interface.
        const requiredExports = [
            "get_input_buffer",
            "set_expression",
            "generate_image",
            "get_pixel_buffer",
            "get_pixel_buffer_size"
        ];

        for (const name of requiredExports) {
            if (typeof wasm[name] !== "function") {
                throw new Error(
                    `Missing WASM export: ${name}`
                );
            }
        }

        if (!(memory instanceof WebAssembly.Memory)) {
            throw new Error("WASM memory export is missing.");
        }

        setAppStatus("WebAssembly loaded successfully.");

        console.log("WASM initialized:", wasm);
        console.log("WASM exports:", Object.keys(wasm));
    }

    // --------------------------------------------------
    // SET EXPRESSIONS IN WASM
    // --------------------------------------------------

    function prepareExpressions() {

        const encoder = new TextEncoder();

        for (let i = 0; i < expressionInputs.length; i++) {

            const expression = expressionInputs[i].value.trim();

            if (!expression) {
                throw new Error(
                    `Expression for channel ${i} cannot be empty.`
                );
            }

            const bytes = encoder.encode(expression);

            const inputPtr = wasm.get_input_buffer();

            if (inputPtr < 0 ||
                inputPtr + bytes.length > memory.buffer.byteLength) {
                throw new Error(
                    `Expression buffer overflow in channel ${i}.`
                );
            }

            new Uint8Array(
                memory.buffer,
                inputPtr,
                bytes.length
            ).set(bytes);

            const result = wasm.set_expression(
                i,
                bytes.length
            );

            if (result !== 0) {
                throw new Error(
                    `Invalid expression in channel ${i}.`
                );
            }
        }
    }

    // --------------------------------------------------
    // GENERATE ONE FRAME
    // --------------------------------------------------

    function generateFrame(time = 0) {

        const width = canvas.width;
        const height = canvas.height;

        const result = wasm.generate_image(
            width,
            height,
            time
        );

        if (result !== 0) {
            throw new Error(
                "WASM image generation failed."
            );
        }

        // Retrieve the pixel buffer.
        const pixelPtr = wasm.get_pixel_buffer();
        const pixelSize = wasm.get_pixel_buffer_size();

        const requiredSize = width * height * 4;

        if (pixelPtr < 0 ||
            pixelSize < requiredSize ||
            pixelPtr + requiredSize > memory.buffer.byteLength) {
            throw new Error(
                "Invalid WASM pixel buffer."
            );
        }

        // Copy WASM memory into JavaScript-owned memory.
        // This avoids problems if WASM memory grows later.
        const pixels = new Uint8ClampedArray(
            new Uint8Array(
                memory.buffer,
                pixelPtr,
                requiredSize
            )
        );

        const imageData = new ImageData(
            pixels,
            width,
            height
        );

        ctx.putImageData(imageData, 0, 0);

        hasGeneratedImage = true;
    }

    // --------------------------------------------------
    // GENERATE STILL IMAGE
    // --------------------------------------------------

    function generateImage() {

        if (!wasm) {
            throw new Error("WebAssembly is not initialized.");
        }

        if (isAnimating) {
            stopAnimation();
        }

        prepareExpressions();

        generateFrame(0);

        hasGeneratedImage = true;

        setAppStatus(
            `Image generated: ${canvas.width} × ${canvas.height}`
        );
    }

    // --------------------------------------------------
    // CANVAS RESIZING
    // --------------------------------------------------

    function resizeCanvas() {

        const width = Number(widthSlider.value);
        const height = Number(heightSlider.value);

        if (isAnimating) {
            stopAnimation();
        }

        canvas.width = width;
        canvas.height = height;

        widthValue.textContent = width;
        heightValue.textContent = height;

        if (hasGeneratedImage && wasm) {
            try {
                if (applicationMode.value === "animation") {
                    prepareExpressions();
                    generateFrame(0);
                } else {
                    generateImage();
                }
            } catch (error) {
                setError(error);
            }
        }
    }

    widthSlider.addEventListener("input", () => {
        widthValue.textContent = widthSlider.value;
    });

    heightSlider.addEventListener("input", () => {
        heightValue.textContent = heightSlider.value;
    });

    widthSlider.addEventListener("change", resizeCanvas);
    heightSlider.addEventListener("change", resizeCanvas);

    // --------------------------------------------------
    // IMAGE DOWNLOAD
    // --------------------------------------------------

    function sanitizeFilename(filename) {

        return filename
            .trim()
            .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
            .replace(/\.+$/g, "") ||
            "canvas";
    }


    function downloadBlob(blob, filename, type = "image", format = null) {

        if (!(blob instanceof Blob) || blob.size === 0) {
            throw new Error("Cannot download an empty or invalid Blob.");
        }

        const isAnimation = type === "animation";

        let extension;
        let mimeType;

        if (isAnimation) {

            // Animation downloads use WebM.
            mimeType = "video/webm";
            extension = "webm";

            if (!blob.type.startsWith("video/")) {
                throw new Error("Invalid animation Blob format.");
            }

        } else {

            // Image downloads support PNG, JPEG and WEBP.
            const imageFormats = {
                "image/png": "png",
                "image/jpeg": "jpg",
                "image/webp": "webp"
            };

            mimeType = format || blob.type;
            extension = imageFormats[mimeType];

            if (!extension) {
                throw new Error("Unsupported image download format.");
            }
        }

        const safeFilename = sanitizeFilename(filename);

        // Avoid duplicate file extensions.
        const baseFilename = safeFilename.replace(
            /\.(png|jpe?g|webp|webm)$/i,
            ""
        );

        const finalFilename = `${baseFilename}.${extension}`;

        // Create an object URL for the Blob.
        const url = URL.createObjectURL(blob);

        const link = document.createElement("a");

        link.href = url;
        link.download = finalFilename;

        document.body.appendChild(link);
        link.click();
        link.remove();

        // Release the object URL after the download starts.
        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 2000);

        // Update the appropriate status panel.
        if (isAnimation) {
            setAnimationStatus(`Downloaded animation: ${finalFilename}`);
        } else {
            setAppStatus(`Downloaded image: ${finalFilename}`);
        }
    }



    downloadImgBtn.addEventListener("click", () => {

        try {

            if (!hasGeneratedImage) {
                generateImage();
            }

            const filename = sanitizeFilename(filenameInput.value);
            const format = formatSelect.value;

            canvas.toBlob(blob => {

                try {

                    if (!blob) {
                        throw new Error("Failed to create image Blob.");
                    }

                    downloadBlob(
                        blob,
                        filename,
                        "image",
                        format
                    );

                } catch (error) {
                    setError(error);
                }

            }, format);

        } catch (error) {
            setError(error);
        }
    });

    // --------------------------------------------------
    // APPLICATION MODE
    // --------------------------------------------------

    function updateApplicationMode() {

        const animationMode =
            applicationMode.value === "animation";

        pictureDownloadPanel.hidden = animationMode;
        animationPanel.hidden = !animationMode;

        modeDescription.textContent = animationMode ?
            "Generate animated artwork using your channel expressions." :
            "Generate one still image from your channel expressions.";

        generateBtn.textContent = animationMode ?
            "Generate Animation Frame" :
            "Generate Image";

        if (animationMode) {
            setAppStatus("Animation mode selected.");
        } else {
            if (isAnimating) {
                stopAnimation();
            }

            setAppStatus("Picture mode selected.");
        }

        // Preserve the current image while switching modes.
    }

    applicationMode.addEventListener(
        "change",
        updateApplicationMode
    );

    // --------------------------------------------------
    // GENERATE BUTTON
    // --------------------------------------------------

    generateBtn.addEventListener("click", () => {

        try {

            if (applicationMode.value === "animation") {

                if (isAnimating) {
                    stopAnimation();
                }

                prepareExpressions();
                generateFrame(0);

                setAnimationStatus(
                    "Animation frame generated successfully."
                );

                setAppStatus("Animation frame generated.");

            } else {

                generateImage();

            }

        } catch (error) {
            setError(error);
        }
    });

    // --------------------------------------------------
    // ANIMATION SETTINGS
    // --------------------------------------------------

    animationFps.addEventListener("input", () => {
        fpsValue.textContent = animationFps.value;
    });

    animationDuration.addEventListener("input", () => {
        durationValue.textContent = animationDuration.value;
    });

    // --------------------------------------------------
    // ANIMATION FRAME LOOP
    // --------------------------------------------------

    function animationLoopFrame(timestamp) {

        if (!isAnimating) {
            return;
        }

        const fps = Number(animationFps.value);
        const frameInterval = 1000 / fps;

        if (timestamp - lastFrameTime >= frameInterval) {

            lastFrameTime = timestamp;

            const elapsedTime =
                (timestamp - animationStartTime) / 1000;

            try {

                generateFrame(elapsedTime);

            } catch (error) {

                lastAnimationError = error;
                stopAnimation();
                setError(error);

                return;
            }
        }

        // Continue until stopped or the preview duration expires.
        animationFrameId = requestAnimationFrame(animationLoopFrame);
    }

    // --------------------------------------------------
    // START ANIMATION
    // --------------------------------------------------

    function startAnimation(recording = false) {

        if (!wasm) {
            throw new Error("WebAssembly is not initialized.");
        }

        if (isAnimating) {
            stopAnimation();
        }

        prepareExpressions();

        // Generate the first frame immediately.
        generateFrame(0);

        const duration =
            Number(animationDuration.value);

        isAnimating = true;
        isRecording = recording;

        lastAnimationError = null;

        animationStartTime = performance.now();
        lastFrameTime = animationStartTime;

        playAnimationBtn.disabled = true;
        stopAnimationBtn.disabled = false;
        recordAnimationBtn.disabled = true;

        setAnimationStatus(
            recording ?
            `Recording animation at ${animationFps.value} FPS...` :
            `Playing animation at ${animationFps.value} FPS...`
        );

        animationFrameId = requestAnimationFrame(animationLoopFrame);

        // Recording always respects the selected duration.
        // Preview can loop until manually stopped.
        if (recording || !animationLoopCheckbox.checked) {

            recordingTimeout = setTimeout(() => {

                if (isAnimating) {
                    stopAnimation();
                }

            }, duration * 1000);
        }
    }

    // --------------------------------------------------
    // STOP ANIMATION
    // --------------------------------------------------

    function stopAnimation() {

        if (animationFrameId !== null) {
            cancelAnimationFrame(animationFrameId);
            animationFrameId = null;
        }

        if (recordingTimeout !== null) {
            clearTimeout(recordingTimeout);
            recordingTimeout = null;
        }

        isAnimating = false;

        playAnimationBtn.disabled = false;
        stopAnimationBtn.disabled = true;
        recordAnimationBtn.disabled = false;

        if (mediaRecorder &&
            mediaRecorder.state !== "inactive") {

            mediaRecorder.stop();

        } else if (!isRecording) {

            setAnimationStatus("Animation stopped.");

        }

        if (animationStream && !mediaRecorder) {
            animationStream.getTracks().forEach(track => {
                track.stop();
            });

            animationStream = null;
        }
    }

    // --------------------------------------------------
    // ANIMATION BUTTON EVENTS
    // --------------------------------------------------

    playAnimationBtn.addEventListener("click", () => {

        try {
            startAnimation(false);
        } catch (error) {
            stopAnimation();
            setError(error);
        }
    });

    stopAnimationBtn.addEventListener("click", () => {
        stopAnimation();
    });

    // --------------------------------------------------
    // WEBM RECORDING
    // --------------------------------------------------

    function getSupportedRecorderMimeType() {

        const formats = [
            "video/webm;codecs=vp9",
            "video/webm;codecs=vp8",
            "video/webm"
        ];

        for (const format of formats) {

            if (MediaRecorder.isTypeSupported(format)) {
                return format;
            }
        }

        throw new Error(
            "Your browser does not support WebM recording."
        );
    }

    async function recordAnimation() {

        if (!canvas.captureStream) {
            throw new Error(
                "Canvas recording is not supported by this browser."
            );
        }

        if (!window.MediaRecorder) {
            throw new Error(
                "MediaRecorder is not supported by this browser."
            );
        }

        // Clear any previous recording.
        recordedAnimationBlob = null;
        recordedChunks = [];

        downloadAnimationBtn.disabled = true;

        const fps = Number(animationFps.value);

        const mimeType = getSupportedRecorderMimeType();

        // Capture the canvas at the selected frame rate.
        animationStream = canvas.captureStream(fps);

        mediaRecorder = new MediaRecorder(
            animationStream, {
                mimeType: mimeType
            }
        );

        mediaRecorder.ondataavailable = event => {

            if (event.data && event.data.size > 0) {
                recordedChunks.push(event.data);
            }
        };

        mediaRecorder.onerror = event => {

            const error = event.error || new Error(
                "Animation recording failed."
            );

            setError(error);
        };

        mediaRecorder.onstop = () => {

            recordedAnimationBlob = new Blob(
                recordedChunks, {
                    type: "video/webm"
                }
            );

            if (animationStream) {

                animationStream.getTracks().forEach(track => {
                    track.stop();
                });

                animationStream = null;
            }

            mediaRecorder = null;

            isRecording = false;

            if (recordedAnimationBlob.size > 0) {

                downloadAnimationBtn.disabled = false;

                setAnimationStatus(
                    `Recording complete. Size: ${
                        (recordedAnimationBlob.size / 1024 / 1024).toFixed(2)
                    } MB. Ready to download.`
                );

            } else {

                setAnimationStatus(
                    "Recording failed: no video data was captured."
                );
            }
        };

        mediaRecorder.start(250);

        isRecording = true;

        startAnimation(true);
    }

    recordAnimationBtn.addEventListener("click", async() => {

        try {

            await recordAnimation();

        } catch (error) {

            if (mediaRecorder &&
                mediaRecorder.state !== "inactive") {
                mediaRecorder.stop();
            }

            if (animationStream) {
                animationStream.getTracks().forEach(track => {
                    track.stop();
                });

                animationStream = null;
            }

            mediaRecorder = null;
            isRecording = false;

            stopAnimation();

            setError(error);
        }
    });

    // --------------------------------------------------
    // ANIMATION DOWNLOAD
    // --------------------------------------------------


    downloadAnimationBtn.addEventListener("click", () => {

        try {

            if (!recordedAnimationBlob) {
                throw new Error(
                    "Record an animation before downloading."
                );
            }

            const filename = sanitizeFilename(
                animationFilename.value
            );

            downloadBlob(
                recordedAnimationBlob,
                filename,
                "animation"
            );

        } catch (error) {
            setError(error);
        }
    });


    // --------------------------------------------------
    // INITIALIZE APPLICATION
    // --------------------------------------------------

    updateApplicationMode();

    fpsValue.textContent = animationFps.value;
    durationValue.textContent = animationDuration.value;

    widthValue.textContent = canvas.width;
    heightValue.textContent = canvas.height;

    try {

        setAppStatus("Loading WebAssembly...");

        await loadWasm();

        // Generate an initial still image.
        prepareExpressions();
        generateFrame(0);

        setAppStatus(
            "Ready. Initial artwork generated successfully."
        );

    } catch (error) {

        console.error("Initialization failed:", error);

        setAppStatus(
            `Initialization failed: ${error.message}`
        );
    }
}

// --------------------------------------------------
// DOM INITIALIZATION
// --------------------------------------------------

document.addEventListener("DOMContentLoaded", async() => {
    try {
        await init();
    } catch (error) {
        console.error("Application initialization failed:", error);

        const status = document.getElementById("app-status");

        if (status) {
            status.textContent = `Initialization failed: ${error.message}`;
        }
    }
});