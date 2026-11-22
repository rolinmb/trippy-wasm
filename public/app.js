async function init() {

    const canvas = document.getElementById("canvas");
    const ctx = canvas.getContext("2d");

    const generateBtn = document.getElementById("generate-btn");
    const downloadBtn = document.getElementById("download-btn");

    const widthSlider = document.getElementById("canvas-width");
    const heightSlider = document.getElementById("canvas-height");

    const widthValue = document.getElementById("width-value");
    const heightValue = document.getElementById("height-value");

    const filenameInput = document.getElementById("filename");
    const formatSelect = document.getElementById("image-format");

    // Load the actual WebAssembly binary.
    const response = await fetch("./wasm/app.wasm");

    if (!response.ok) {
        throw new Error("Failed to load app.wasm");
    }

    // Supply JavaScript implementations of the mathematical
    // functions imported by the WASM module.
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

    const { instance } = await WebAssembly.instantiateStreaming(
        response,
        imports
    );

    const wasm = instance.exports;
    const memory = wasm.memory;

    let hasGeneratedImg = false;

    function generateImage() {

        const expressions = [
            document.getElementById("r-expression").value,
            document.getElementById("g-expression").value,
            document.getElementById("b-expression").value,
            document.getElementById("a-expression").value
        ];

        // Pass expressions to WASM.
        for (let i = 0; i < 4; i++) {

            const encoder = new TextEncoder();
            const bytes = encoder.encode(expressions[i]);

            const inputPtr = wasm.get_input_buffer();

            new Uint8Array(memory.buffer, inputPtr, bytes.length)
                .set(bytes);

            const result = wasm.set_expression(i, bytes.length);

            if (result !== 0) {
                throw new Error(`Invalid expression in channel ${i}`);
            }
        }

        const width = canvas.width;
        const height = canvas.height;

        // Generate the image entirely inside WASM.
        const result = wasm.generate_image(
            width,
            height,
            performance.now() / 1000
        );

        if (result !== 0) {
            throw new Error("WASM image generation failed");
        }

        // Read the RGBA pixel buffer from WASM linear memory.
        const pixelPtr = wasm.get_pixel_buffer();
        const pixelSize = wasm.get_pixel_buffer_size();

        const pixels = new Uint8ClampedArray(
            memory.buffer,
            pixelPtr,
            pixelSize
        );

        const imageData = new ImageData(
            new Uint8ClampedArray(pixels),
            width,
            height
        );

        ctx.putImageData(imageData, 0, 0);

        hasGeneratedImg = true;
    }

    function resizeCanvas() {

        canvas.width = Number(widthSlider.value);
        canvas.height = Number(heightSlider.value);

        widthValue.textContent = canvas.width;
        heightValue.textContent = canvas.height;

        if (hasGeneratedImg) {
            generateImage();
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

    generateBtn.addEventListener("click", () => {
        try {
            generateImage();
        } catch (error) {
            console.error(error);
            alert(error.message);
        }
    });

    downloadBtn.addEventListener("click", () => {

        let filename = filenameInput.value.trim() || "canvas";

        const format = formatSelect.value;
        const extension = format.split("/")[1];

        canvas.toBlob(blob => {

            if (!blob) return;

            const url = URL.createObjectURL(blob);

            const link = document.createElement("a");

            link.href = url;
            link.download = `${filename}.${extension}`;

            link.click();

            URL.revokeObjectURL(url);

        }, format);
    });
}

document.addEventListener("DOMContentLoaded", init);