# Run inside Fusion (via the Fusion MCP script runner). Writes the active design as
# glTF 2.0 (.gltf + .bin) keeping the occurrence tree, instancing and body colours.
# Fusion is Z-up in cm; the root node converts to glTF's Y-up metres.
import adsk.core, adsk.fusion, json, os, tempfile, time
from array import array

OUT = os.environ.get('SW_EXPORT_DIR', os.path.join(tempfile.gettempdir(), 'switchwire-export'))
NAME = 'switchwire'


# The CAD is STEP-import grey; colour by component name (first match wins), Voron style.
# (class, [name substrings], rgba, metallic, roughness)
PALETTE = [
    ('clear',     ['door', 'clear panel'],                                   (0.75, 0.85, 0.9, 0.18), 0.0, 0.1),
    ('accent',    ['upper block', 'y belt clamp', 'z chain lower mount', 'lcd knob', 'stealthburner_body',
                   'heatsink', 'keybak_end', 'kill button', 'latch'],       (0.78, 0.07, 0.07, 1), 0.0, 0.55),
    ('extrusion', ['hfs'],                                                   (0.11, 0.11, 0.12, 1), 0.3, 0.5),
    ('rail',      ['mgn12', 'linear guide'],                                 (0.72, 0.73, 0.74, 1), 0.9, 0.3),
    ('brass',     ['threaded insert'],                                       (0.85, 0.68, 0.35, 1), 0.9, 0.35),
    ('motor',     ['nema17', 'ldo-36'],                                      (0.08, 0.08, 0.09, 1), 0.4, 0.45),
    ('steel',     ['m2x', 'm3x', 'm4x', 'm5x', 'm8x', 'din ', 'washer', 'nut', 'spacer', 'gt2 20t', 'drive_gear',
                   'idler_gear', 'shaft', 'f695', 'mr825', 'needle', 'thumb screw', 'spring'], (0.62, 0.63, 0.65, 1), 0.85, 0.35),
    ('sheet',     ['flex-sheet'],                                            (0.70, 0.56, 0.32, 1), 0.2, 0.7),
    ('bed',       ['mk52'],                                                  (0.55, 0.56, 0.57, 1), 0.6, 0.4),
    ('belt',      ['belt'],                                                  (0.05, 0.05, 0.05, 1), 0.0, 0.9),
    ('panel',     ['panel', 'deck'],                                         (0.06, 0.06, 0.07, 1), 0.1, 0.6),
    ('pcb',       ['skr', 'raspberry', 'rpi zero', 'lcd_board', 'rgbw', 'mini12864'], (0.07, 0.35, 0.16, 1), 0.1, 0.6),
    ('psu',       ['meanwell', 'mw rs-25'],                                  (0.74, 0.75, 0.76, 1), 0.8, 0.4),
    ('ptfe',      ['ptfe', 'pfte'],                                          (0.92, 0.92, 0.9, 0.7), 0.0, 0.4),
]
PRINTED = ('printed', (0.15, 0.15, 0.16, 1), 0.0, 0.65)


def classify(comp_name):
    low = comp_name.lower()
    for cls, keys, rgba, met, rough in PALETTE:
        if any(k in low for k in keys):
            return cls, rgba, met, rough
    return PRINTED


def run(_context: str):
    t0 = time.time()
    design = adsk.fusion.Design.cast(adsk.core.Application.get().activeProduct)
    os.makedirs(OUT, exist_ok=True)

    buf = bytearray()
    views, accessors, meshes, materials, nodes = [], [], [], [], []
    mat_ix, mesh_ix = {}, {}
    appr_names = {}
    tris = 0

    def add_view(data, target):
        while len(buf) % 4:
            buf.append(0)
        off = len(buf)
        buf.extend(data)
        views.append({'buffer': 0, 'byteOffset': off, 'byteLength': len(data), 'target': target})
        return len(views) - 1

    def material(comp_name):
        name, rgba, met, rough = classify(comp_name)
        if name not in mat_ix:
            m = {'name': name, 'pbrMetallicRoughness': {'baseColorFactor': list(rgba),
                 'metallicFactor': met, 'roughnessFactor': rough}}
            if rgba[3] < 1:
                m['alphaMode'] = 'BLEND'
                m['doubleSided'] = True
            materials.append(m)
            mat_ix[name] = len(materials) - 1
        appr_names[name] = appr_names.get(name, 0) + 1
        return mat_ix[name]

    def mesh_for(body, comp_name, key):
        nonlocal tris
        if key in mesh_ix:
            return mesh_ix[key]
        # displayMeshes.bestMesh throws InternalValidationError on some bodies; always tessellate
        calc = body.meshManager.createMeshCalculator()
        calc.setQuality(adsk.fusion.TriangleMeshQualityOptions.NormalQualityTriangleMesh)
        tm = calc.calculate()
        pos = array('f', tm.nodeCoordinatesAsFloat)
        nrm = array('f', tm.normalVectorsAsFloat)
        idx = array('I', tm.nodeIndices)
        if len(idx) == 0:
            mesh_ix[key] = None
            return None
        tris += len(idx) // 3
        n = len(pos) // 3
        mn = [min(pos[i::3]) for i in range(3)]
        mx = [max(pos[i::3]) for i in range(3)]
        accessors.append({'bufferView': add_view(pos.tobytes(), 34962), 'componentType': 5126, 'count': n, 'type': 'VEC3', 'min': mn, 'max': mx})
        pa = len(accessors) - 1
        attrs = {'POSITION': pa}
        if len(nrm) == len(pos):
            accessors.append({'bufferView': add_view(nrm.tobytes(), 34962), 'componentType': 5126, 'count': n, 'type': 'VEC3'})
            attrs['NORMAL'] = len(accessors) - 1
        accessors.append({'bufferView': add_view(idx.tobytes(), 34963), 'componentType': 5125, 'count': len(idx), 'type': 'SCALAR'})
        meshes.append({'name': body.name, 'primitives': [{'attributes': attrs, 'indices': len(accessors) - 1, 'material': material(comp_name)}]})
        mesh_ix[key] = len(meshes) - 1
        return mesh_ix[key]

    def mul(a, b):  # row-major 4x4
        return [sum(a[r * 4 + k] * b[k * 4 + c] for k in range(4)) for r in range(4) for c in range(4)]

    def walk(comp, parent_occ=None):
        """Child node indices for a component's bodies and sub-occurrences.

        Uses proxy (assembly-context) occurrences: some parts are positioned in the
        assembly context, so a native occurrence's own transform can be identity
        while the proxy carries the real placement. local = inverse(parent world) x world.
        """
        kids = []
        for i in range(comp.bRepBodies.count):
            b = comp.bRepBodies.item(i)
            if not b.isLightBulbOn:
                continue
            mi = mesh_for(b, comp.name, (comp.id, i))
            if mi is None:
                continue
            nodes.append({'name': b.name, 'mesh': mi})
            kids.append(len(nodes) - 1)
        occs = parent_occ.childOccurrences if parent_occ else comp.occurrences
        inv = None
        if parent_occ:
            pinv = parent_occ.transform2.copy()
            pinv.invert()
            inv = pinv.asArray()
        for i in range(occs.count):
            o = occs.item(i)
            if not o.isLightBulbOn:
                continue
            node = {'name': o.name}
            w = o.transform2.asArray()  # world (assembly context), row-major
            m = mul(inv, w) if inv else w
            # glTF wants column-major
            col = [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]]
            if col != [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]:
                node['matrix'] = col
            nodes.append(node)
            ni = len(nodes) - 1
            ch = walk(o.component, o)
            if ch:
                nodes[ni]['children'] = ch
            kids.append(ni)
        return kids

    root_children = walk(design.rootComponent)
    # Z-up cm -> Y-up m: rotate -90 deg about X, scale 0.01
    nodes.append({'name': 'Switchwire', 'children': root_children,
                  'rotation': [-0.70710678, 0, 0, 0.70710678], 'scale': [0.01, 0.01, 0.01]})
    gltf = {'asset': {'version': '2.0', 'generator': 'fusion_export_gltf.py'},
            'scene': 0, 'scenes': [{'nodes': [len(nodes) - 1]}],
            'nodes': nodes, 'meshes': meshes, 'materials': materials,
            'accessors': accessors, 'bufferViews': views,
            'buffers': [{'uri': NAME + '.bin', 'byteLength': len(buf)}]}
    with open(os.path.join(OUT, NAME + '.bin'), 'wb') as f:
        f.write(buf)
    with open(os.path.join(OUT, NAME + '.gltf'), 'w') as f:
        json.dump(gltf, f)
    print(f'nodes={len(nodes)} meshes={len(meshes)} materials={len(materials)} tris={tris} bin={len(buf)/1e6:.1f}MB t={time.time()-t0:.1f}s')
    for k, v in sorted(appr_names.items(), key=lambda kv: -kv[1]):
        r, g, b = materials[mat_ix[k]]['pbrMetallicRoughness']['baseColorFactor'][:3]
        print(f'  {v:4d}  {k}  ({r:.2f},{g:.2f},{b:.2f})')
