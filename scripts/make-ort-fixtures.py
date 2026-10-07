# Writes the tiny ONNX graphs in test/fixtures/ort/ that scripts/probe-ort.mjs
# runs. Each holds one of the quantized operators in Gemma's q4 file, with the
# same input types, so a runtime that cannot run them fails in seconds instead
# of after a 344 MB download.
#
#   python3 -m pip install onnx numpy && python3 scripts/make-ort-fixtures.py
import os
import numpy as np
import onnx
from onnx import helper as h, numpy_helper as nh, TensorProto as T

OUT = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures', 'ort')
OPSETS = [h.make_opsetid('', 21), h.make_opsetid('com.microsoft', 1)]
rng = np.random.default_rng(0)


def save(name, node, inputs, inits):
    graph = h.make_graph([node], name, inputs, [h.make_tensor_value_info('y', T.FLOAT, None)], inits)
    onnx.save(h.make_model(graph, opset_imports=OPSETS, ir_version=10), os.path.join(OUT, f'{name}.onnx'))


idx = h.make_tensor_value_info('idx', T.INT64, [1, 3])
data = nh.from_array(rng.integers(0, 255, (16, 32), dtype=np.uint8), 'data')  # 4-bit, packed in uint8
scales = nh.from_array(rng.random((16, 2), dtype=np.float32), 'scales')
zero_points = nh.from_array(np.full((16, 1), 0x88, dtype=np.uint8), 'zp')
gbq = dict(gather_axis=0, quantize_axis=1, block_size=32, bits=4, domain='com.microsoft')

# The embedding lookup in the q4 file.
save('gather_block_quantized', h.make_node('GatherBlockQuantized', ['data', 'idx', 'scales'], ['y'], **gbq), [idx], [data, scales])
save('gather_block_quantized_zp', h.make_node('GatherBlockQuantized', ['data', 'idx', 'scales', 'zp'], ['y'], **gbq), [idx], [data, scales, zero_points])
# The 4-bit matrix multiply in every layer.
a = h.make_tensor_value_info('a', T.FLOAT, [1, 64])
b = nh.from_array(rng.integers(0, 255, (8, 2, 16), dtype=np.uint8), 'B')
s = nh.from_array(rng.random((16,), dtype=np.float32), 'S')
save('matmul_nbits', h.make_node('MatMulNBits', ['a', 'B', 'S'], ['y'], K=64, N=8, bits=4, block_size=32, domain='com.microsoft'), [a], [b, s])
print('wrote', sorted(os.listdir(OUT)))
