#version 440
// máscara de puntos de glyph (components/shaders/dots.frag): cada punto toma el color del centro de su celda, monocromo.
// Para iconos chicos (barra de glyph-tok) la rejilla es densa — paso en px físicos — así que el radio y el borde suave
// van en proporción al paso (glyph los fija en px y a 2 px de paso los puntos se borran). Con paso par en px físicos el
// centro cae en un px (off): 1 px encendido de cada 2 — si no, los 4 px de la celda quedan iguales y no hay puntos
// compilar: /usr/lib/qt6/bin/qsb --qt6 -o dots.frag.qsb dots.frag

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;

layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 size;   // tamaño del elemento, px lógicos
    float pitch; // paso de la rejilla, px lógicos
    float circ;  // 1 — solo puntos dentro del círculo
    float soft;  // borde suave del punto, px lógicos (≈ medio px físico)
    float off;   // centro del punto dentro de la celda, px lógicos: pitch/2, o el centro de un px físico si el paso es par
    float rad;   // radio del punto, px lógicos
};
layout(binding = 1) uniform sampler2D source;

void main() {
    vec2 p = qt_TexCoord0 * size;
    vec2 c = floor(p / pitch) * pitch + off;
    float r = rad;
    float m = 1.0 - smoothstep(r - soft, r + soft, distance(p, c));
    if (circ > 0.5 && distance(c, size * 0.5) > min(size.x, size.y) * 0.5) m = 0.0;
    vec4 t = texture(source, c / size);
    float l = t.a > 0.0 ? dot(t.rgb / t.a, vec3(0.299, 0.587, 0.114)) : 0.0;
    fragColor = vec4(vec3(l), 1.0) * t.a * m * qt_Opacity;
}
