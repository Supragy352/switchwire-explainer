"""Pack the Fusion export (.gltf + .bin, float32) into a quantized, gzipped GLB.

Positions -> int16 normalized, normals -> int8 normalized (KHR_mesh_quantization,
read natively by three.js GLTFLoader), indices -> uint16 where they fit.
The dequantization (centre + half-extent) goes on each mesh's leaf node.
Usage: python -I pack_glb.py in.gltf out.b64.txt  (base64 of the gzipped GLB)
"""
import base64, gzip, json, struct, sys
from array import array

src, dst = sys.argv[1], sys.argv[2]
g = json.load(open(src))
raw = open(src[:-5] + '.bin', 'rb').read()


def read(acc_ix, typ):
    a = g['accessors'][acc_ix]
    v = g['bufferViews'][a['bufferView']]
    out = array(typ)
    out.frombytes(raw[v['byteOffset']:v['byteOffset'] + v['byteLength']])
    return out


buf = bytearray()
views, accessors = [], []


def add(data, target, stride=None):
    while len(buf) % 4:
        buf.append(0)
    view = {'buffer': 0, 'byteOffset': len(buf), 'byteLength': len(data), 'target': target}
    if stride:
        view['byteStride'] = stride
    buf.extend(data)
    views.append(view)
    return len(views) - 1


dequant = []  # per mesh: (centre, half-extent)
for mesh in g['meshes']:
    prim = mesh['primitives'][0]
    pos = read(prim['attributes']['POSITION'], 'f')
    n = len(pos) // 3
    mn = [min(pos[i::3]) for i in range(3)]
    mx = [max(pos[i::3]) for i in range(3)]
    c = [(mn[i] + mx[i]) / 2 for i in range(3)]
    h = max(max((mx[i] - mn[i]) / 2 for i in range(3)), 1e-6)  # uniform scale keeps normals valid
    q = array('h', bytes(8 * n))  # int16 x4 per vertex (4th = padding for 4-byte stride)
    for i in range(n):
        for k in range(3):
            q[4 * i + k] = round((pos[3 * i + k] - c[k]) / h * 32767)
    # self-check: dequantized positions land within one quantization step of the source
    step = h / 32767
    for i in range(0, n, max(1, n // 50)):
        for k in range(3):
            assert abs(q[4 * i + k] / 32767 * h + c[k] - pos[3 * i + k]) <= step, (mesh['name'], i, k)
    accessors.append({'bufferView': add(q.tobytes(), 34962, 8), 'componentType': 5122, 'normalized': True,
                      'count': n, 'type': 'VEC3',
                      # glTF min/max are in the raw component type (int16), not normalized floats
                      'min': [min(q[k::4]) for k in range(3)],
                      'max': [max(q[k::4]) for k in range(3)]})
    attrs = {'POSITION': len(accessors) - 1}
    if 'NORMAL' in prim['attributes']:
        nr = read(prim['attributes']['NORMAL'], 'f')
        qn = array('b', bytes(4 * n))
        for i in range(n):
            for k in range(3):
                qn[4 * i + k] = max(-127, min(127, round(nr[3 * i + k] * 127)))
        accessors.append({'bufferView': add(qn.tobytes(), 34962, 4), 'componentType': 5120, 'normalized': True,
                          'count': n, 'type': 'VEC3'})
        attrs['NORMAL'] = len(accessors) - 1
    idx = read(prim['indices'], 'I')
    if n <= 65535:
        idx, ctype = array('H', idx), 5123
    else:
        ctype = 5125
    accessors.append({'bufferView': add(idx.tobytes(), 34963), 'componentType': ctype, 'count': len(idx), 'type': 'SCALAR'})
    prim['attributes'], prim['indices'] = attrs, len(accessors) - 1
    dequant.append((c, h))

# The exporter's palette is written in sRGB; glTF baseColorFactor is linear.
def to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


for mat in g['materials']:
    f = mat['pbrMetallicRoughness']['baseColorFactor']
    mat['pbrMetallicRoughness']['baseColorFactor'] = [to_linear(f[0]), to_linear(f[1]), to_linear(f[2]), f[3]]

# Mesh nodes are leaves with no transform; give each its dequantization transform.
for node in g['nodes']:
    if 'mesh' in node:
        assert 'matrix' not in node and 'children' not in node, node['name']
        c, h = dequant[node['mesh']]
        node['translation'], node['scale'] = c, [h, h, h]

g['accessors'], g['bufferViews'] = accessors, views
g['buffers'] = [{'byteLength': len(buf)}]
g['extensionsUsed'] = g['extensionsRequired'] = ['KHR_mesh_quantization']
while len(buf) % 4:
    buf.append(0)
js = json.dumps(g, separators=(',', ':')).encode()
js += b' ' * (-len(js) % 4)
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(buf))
glb += struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(buf), 0x004E4942) + bytes(buf)
# Artifacts serve only web types (no .gz/.bin), so ship the gzipped GLB as base64 text.
gz = gzip.compress(glb, compresslevel=9)
with open(dst, 'wb') as f:
    f.write(base64.b64encode(gz))
print(f'glb={len(glb) / 1e6:.1f}MB gz={len(gz) / 1e6:.1f}MB b64={len(gz) * 4 / 3 / 1e6:.1f}MB meshes={len(g["meshes"])}')
