// What the app runs, stated once and shown to the user as-is.
// Sizes are the file sizes on the Hugging Face Hub for this repo and dtype.
export const MODEL = {
  id: 'onnx-community/gemma-3-270m-it-ONNX',
  name: 'Gemma 3 270M IT',
  params: '270M parameters',
  dtype: 'q4',
  file: 'model_q4.onnx_data',
  // onnx/model_q4.onnx_data 322,933,248 B + onnx/model_q4.onnx 242,522 B
  // + tokenizer.json 20,323,013 B + small JSON files ≈ 343.5 MB
  downloadMB: 344,
  license: 'Gemma Terms of Use',
  licenseUrl: 'https://ai.google.dev/gemma/terms',
  modelUrl: 'https://huggingface.co/onnx-community/gemma-3-270m-it-ONNX',
};

// One greedy answer, the same in the browser and in the CI model check.
export const GENERATION = { max_new_tokens: 64, do_sample: false, repetition_penalty: 1.1 };
