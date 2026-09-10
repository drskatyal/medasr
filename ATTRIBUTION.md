# Attribution

**Speech-to-text in this app is Google MedASR.**

MedASR is an automated speech recognition model trained for healthcare audio.
FlowRad Dictate runs a local int8 ONNX copy of that full model. We do
not substitute another ASR engine and we do not ship a distilled student.

Please credit:

> Speech recognition by [MedASR](https://huggingface.co/google/medasr)
> (Google Health AI Developer Foundations).

and keep the HAI-DEF license notice with any redistribution of the weights or
derivatives (quantized ONNX).

Optional on-device **cleanup** after you release the mic uses Qwen3-1.7B
(Apache 2.0) and/or Gemma 4 E4B (Gemma Terms). Those models edit the MedASR
transcript; they do not transcribe audio.
