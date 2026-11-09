#!/usr/bin/env python3
"""Genera pipewire/x1sound.conf a partir de la conf Dolby generada por speaker-tuning-to-easyeffects.
Copia literalmente los nodos LV2 peq/reg/limiter (y sus controles) y antepone las etapas de control de x1sound.
Uso: python3 -I render_conf.py <Dolby_X.conf> <ir.irs> <salida.conf>"""
import re, sys

src, ir, out = sys.argv[1:4]
# opcional: ganancia de entrada del regulador en dB (por defecto se conserva la de la conf de origen)
g_in_db = float(sys.argv[4]) if len(sys.argv) > 4 else None
EQ = [125, 250, 500, 1000, 2000, 4000, 8000, 16000]   # ecualizador gráfico por octavas (eq1..eq8)
s = open(src).read()

def block(name):
    # nodo { type = "lv2" name = "<name>" ... } con llaves equilibradas
    i = s.index(f'name = "{name}"')
    a = s.rindex('{', 0, i)
    depth, j = 0, a
    while True:
        if s[j] == '{': depth += 1
        elif s[j] == '}':
            depth -= 1
            if depth == 0: return s[a:j + 1]
        j += 1

peq, reg, lim = block("peq"), block("reg"), block("limiter")
if g_in_db is not None:
    reg = re.sub(r'g_in = [0-9.]+[^\n]*', f'g_in = {10 ** (g_in_db / 20):.4f}', reg, count=1)
# ganancia de entrada del regulador: se conserva la calibrada (+18 dB) si la conf la tiene
m = re.search(r'g_in = ([0-9.]+)', reg)

def bq(name, label, f, q, g):
    return f'{{ type = "builtin" name = "{name}" label = "{label}" control = {{ "Freq" = {f} "Q" = {q} "Gain" = {g} }} }}'

nodes = [
    '{ type = "builtin" name = "sp_l" label = "copy" }', '{ type = "builtin" name = "sp_r" label = "copy" }',
    f'{{ type = "builtin" name = "conv_l" label = "convolver" config = {{ filename = "{ir}" channel = 0 gain = 1.0 }} }}',
    f'{{ type = "builtin" name = "conv_r" label = "convolver" config = {{ filename = "{ir}" channel = 1 gain = 1.0 }} }}',
    # "Gain 1" = corrección Dolby (AO), "Gain 2" = señal seca (perfil off)
    '{ type = "builtin" name = "mix_l" label = "mixer" control = { "Gain 1" = 1.0 "Gain 2" = 0.0 } }',
    '{ type = "builtin" name = "mix_r" label = "mixer" control = { "Gain 1" = 1.0 "Gain 2" = 0.0 } }',
    bq("bass_l", "bq_lowshelf", 150.0, 0.7071, 6.0), bq("bass_r", "bq_lowshelf", 150.0, 0.7071, 6.0),
    bq("treble_l", "bq_highshelf", 6000.0, 0.7071, 0.0), bq("treble_r", "bq_highshelf", 6000.0, 0.7071, 0.0),
    bq("voice_l", "bq_peaking", 2500.0, 1.0, 0.0), bq("voice_r", "bq_peaking", 2500.0, 1.0, 0.0),
] + [bq(f"eq{i+1}_{c}", "bq_peaking", float(f), 1.41, 0.0) for i, f in enumerate(EQ) for c in "lr"] + [
    peq, reg, lim,
]
links = []
for c in "lr":
    links += [(f"sp_{c}:Out", f"conv_{c}:In"), (f"conv_{c}:Out", f"mix_{c}:In 1"), (f"sp_{c}:Out", f"mix_{c}:In 2"),
              (f"mix_{c}:Out", f"bass_{c}:In"), (f"bass_{c}:Out", f"treble_{c}:In"), (f"treble_{c}:Out", f"voice_{c}:In"),
              (f"voice_{c}:Out", f"eq1_{c}:In")]
    links += [(f"eq{i}_{c}:Out", f"eq{i+1}_{c}:In") for i in range(1, len(EQ))]
    links += [(f"eq{len(EQ)}_{c}:Out", f"peq:in_{c}"), (f"peq:out_{c}", f"reg:in_{c}"), (f"reg:out_{c}", f"limiter:in_{c}")]
link_txt = "\n".join(f'                    {{ output = "{a}" input = "{b}" }}' for a, b in links)
target = re.search(r'filter\.smart\.target = \{\s*node\.name = "([^"]+)"', s).group(1)

conf = f'''# x1sound: cadena DSP de los altavoces internos del ThinkPad X1 Carbon Gen 9 (generada por tools/render_conf.py).
# Etapas: corrección Dolby (FIR) o señal seca (perfil off) → graves → agudos → voz → EQ 8 bandas → EQ Dolby (HP 100 Hz) →
# regulador por bandas (g_in = ganancia/volmax) → limitador -1 dBFS. Toda ganancia positiva va ANTES del regulador
# y del limitador. Controles en vivo: x1sound (daemon) con pw-cli; el limitador nunca se toca.
# Fuente: {src}
context.modules = [
    {{ name = libpipewire-module-filter-chain
        args = {{
            node.description = "X1 Speaker DSP"
            media.name = "X1 Speaker DSP"
            filter.graph = {{
                nodes = [
{chr(10).join("                    " + n for n in nodes)}
                ]
                links = [
{link_txt}
                ]
                inputs = [ "sp_l:In" "sp_r:In" ]
                outputs = [ "limiter:out_l" "limiter:out_r" ]
            }}
            audio.channels = 2
            audio.position = [ "FL" "FR" ]
            capture.props = {{
                node.name = "effect_input.x1sound"
                media.class = "Audio/Sink"
                node.link-group = "x1sound_smart_filter"
                filter.smart = true
                filter.smart.name = "x1sound"
                filter.smart.target = {{ node.name = "{target}" }}
            }}
            playback.props = {{
                node.name = "effect_output.x1sound"
                node.link-group = "x1sound_smart_filter"
                node.passive = true
                stream.dont-remix = true
            }}
        }}
    }}
]
'''
open(out, "w").write(conf)
print(f"ok: {out}  (reg g_in = {m.group(1) if m else '?'}, target = {target})")
