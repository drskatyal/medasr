"""Shared MedASR loader that produces a clean, ONNX-exportable module.

Centralizes the "disable Hub kernels / force eager" hygiene that both the
export and verification scripts need (per Grok's review + reading the Lasr
source: `apply_rotary_pos_emb` is wrapped with `@use_kernel_func_from_hub`
and attention with `@use_kernelized_func`, which try to fetch/compile
optimized kernels from the HF Hub and inject non-traceable ops).
"""

from __future__ import annotations

# These MUST be set before importing transformers.
import os

os.environ.setdefault("HF_HUB_OFFLINE", "0")  # need online for first weight download
os.environ.setdefault("DISABLE_KERNELS", "1")
os.environ.setdefault("KERNELS_DISABLED", "1")
os.environ.setdefault("TRANSFORMERS_NO_ADVISORY_WARNINGS", "1")

import torch  # noqa: E402
import torch.nn.functional as F  # noqa: E402

MODEL_ID = "google/medasr"

# Encoder frame rate facts (from configuration_lasr.py / modeling_lasr.py):
#   mel hop 160 @ 16kHz -> 100 mel frames/s
#   subsampling stride 2, applied twice -> /4 -> 25 encoder frames/s
MEL_FRAMES_PER_S = 100
SUBSAMPLE_FACTOR = 4
ENCODER_FRAMES_PER_S = MEL_FRAMES_PER_S // SUBSAMPLE_FACTOR  # 25
BLANK_ID = 0  # pad_token_id == blank for CTC


def encoder_layer_count(model) -> int:
    enc = model.config.encoder_config
    for attr in ("num_hidden_layers", "num_layers", "n_layers"):
        if hasattr(enc, attr):
            return int(getattr(enc, attr))
    raise RuntimeError("cannot read MedASR encoder layer count")


def load_model_and_processor(model_id: str = MODEL_ID):
    from transformers import AutoModelForCTC, AutoProcessor

    processor = AutoProcessor.from_pretrained(model_id)
    model = AutoModelForCTC.from_pretrained(model_id, torch_dtype=torch.float32)
    model.eval()
    # Force plain eager attention so no SDPA/flash/flex custom op is traced.
    model.config._attn_implementation = "eager"
    if hasattr(model.config, "attn_implementation"):
        model.config.attn_implementation = "eager"
    enc = model.config.encoder_config
    if hasattr(enc, "_attn_implementation"):
        enc._attn_implementation = "eager"
    return model, processor


def patch_depthwise_explicit_padding(model) -> int:
    """Replace the ConvModule's depthwise `padding='same'` with explicit F.pad.

    PyTorch 'same' padding on an even kernel (k=32) is asymmetric (left=15,
    right=16). ORT CPU is pickier about auto_pad than about explicit pads, so
    we bake the identical asymmetric pad into the graph. Numerically identical
    to the original; only the ONNX representation changes. Returns the number
    of modules patched.
    """
    import types

    from transformers.models.lasr.modeling_lasr import LasrEncoderConvolutionModule

    n = 0

    def forward(self, hidden_states, attention_mask=None):
        hidden_states = hidden_states.transpose(1, 2)
        hidden_states = self.pointwise_conv1(hidden_states)
        hidden_states = F.glu(hidden_states, dim=1)
        # attention_mask is None during export (batch=1, no padding) -> skip mask.
        k = self.depthwise_conv.kernel_size[0]
        left, right = (k - 1) // 2, k // 2
        hidden_states = F.pad(hidden_states, (left, right))
        hidden_states = F.conv1d(
            hidden_states,
            self.depthwise_conv.weight,
            self.depthwise_conv.bias,
            stride=1,
            padding=0,
            groups=hidden_states.shape[1],
        )
        hidden_states = self.norm(hidden_states)
        hidden_states = self.activation(hidden_states)
        hidden_states = self.pointwise_conv2(hidden_states)
        return hidden_states.transpose(1, 2)

    for module in model.modules():
        if isinstance(module, LasrEncoderConvolutionModule):
            module.forward = types.MethodType(forward, module)
            n += 1
    return n


class LogitsWrapper(torch.nn.Module):
    """Wraps LasrForCTC so `forward(input_features) -> logits` for a clean export."""

    def __init__(self, model):
        super().__init__()
        self.model = model

    def forward(self, input_features: torch.Tensor) -> torch.Tensor:
        # input_features: [B, T_mel, 128] float32 ; logits: [B, T_mel/4, vocab]
        return self.model(input_features=input_features, attention_mask=None).logits
