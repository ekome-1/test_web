#include <stdint.h>

static void blur_line(uint8_t *source, uint8_t *target, uint32_t width, uint32_t height,
                      uint32_t radius, int horizontal)
{
    uint32_t outer = horizontal ? height : width;
    uint32_t inner = horizontal ? width : height;
    uint32_t stride = horizontal ? 4u : width * 4u;
    uint32_t divisor = radius * 2u + 1u;

    for (uint32_t line = 0; line < outer; line++)
    {
        uint32_t base = horizontal ? line * width * 4u : line * 4u;
        int32_t sums[4] = {0, 0, 0, 0};
        for (int32_t offset = -(int32_t)radius; offset <= (int32_t)radius; offset++)
        {
            uint32_t position = (uint32_t)(offset + (int32_t)radius);
            if (position >= inner) position = inner - 1u;
            uint32_t sample = base + position * stride;
            sums[0] += source[sample];
            sums[1] += source[sample + 1u];
            sums[2] += source[sample + 2u];
            sums[3] += source[sample + 3u];
        }

        for (uint32_t position = 0; position < inner; position++)
        {
            uint32_t target_index = base + position * stride;
            target[target_index] = (uint8_t)(sums[0] / divisor);
            target[target_index + 1u] = (uint8_t)(sums[1] / divisor);
            target[target_index + 2u] = (uint8_t)(sums[2] / divisor);
            target[target_index + 3u] = (uint8_t)(sums[3] / divisor);

            int32_t leaving_signed = (int32_t)position - (int32_t)radius;
            int32_t entering_signed = (int32_t)position + (int32_t)radius + 1;
            uint32_t leaving = leaving_signed < 0 ? 0u : (uint32_t)leaving_signed;
            uint32_t entering = entering_signed < 0 ? 0u : (uint32_t)entering_signed;
            if (leaving >= inner) leaving = inner - 1u;
            if (entering >= inner) entering = inner - 1u;
            uint32_t leaving_index = base + leaving * stride;
            uint32_t entering_index = base + entering * stride;
            sums[0] += source[entering_index] - source[leaving_index];
            sums[1] += source[entering_index + 1u] - source[leaving_index + 1u];
            sums[2] += source[entering_index + 2u] - source[leaving_index + 2u];
            sums[3] += source[entering_index + 3u] - source[leaving_index + 3u];
        }
    }
}

/* Returns 0 when output is in pixels, 1 when it is in scratch, and -1 on invalid input. */
__attribute__((visibility("default")))
int blur_rgba(uint32_t pixels_offset, uint32_t scratch_offset,
              uint32_t width, uint32_t height, uint32_t sigma)
{
    if (width == 0 || height == 0 || width > UINT32_MAX / height / 4u || sigma > 32u)
        return -1;
    uint32_t byte_count = width * height * 4u;
    uint32_t memory_bytes = __builtin_wasm_memory_size(0) * 65536u;
    if (pixels_offset > memory_bytes || scratch_offset > memory_bytes ||
        byte_count > memory_bytes - pixels_offset || byte_count > memory_bytes - scratch_offset ||
        pixels_offset + byte_count > scratch_offset && scratch_offset + byte_count > pixels_offset)
        return -1;

    uint8_t *pixels = (uint8_t *)(uintptr_t)pixels_offset;
    uint8_t *scratch = (uint8_t *)(uintptr_t)scratch_offset;
    for (uint32_t index = 0; index < byte_count; index += 4u)
    {
        uint32_t alpha = pixels[index + 3u];
        pixels[index] = (uint8_t)((pixels[index] * alpha + 127u) / 255u);
        pixels[index + 1u] = (uint8_t)((pixels[index + 1u] * alpha + 127u) / 255u);
        pixels[index + 2u] = (uint8_t)((pixels[index + 2u] * alpha + 127u) / 255u);
    }

    uint8_t *source = pixels;
    uint8_t *target = scratch;
    for (uint32_t pass = 0; pass < 3u; pass++)
    {
        blur_line(source, target, width, height, sigma, 1);
        uint8_t *swap = source; source = target; target = swap;
        blur_line(source, target, width, height, sigma, 0);
        swap = source; source = target; target = swap;
    }

    for (uint32_t index = 0; index < byte_count; index += 4u)
    {
        uint32_t alpha = source[index + 3u];
        if (alpha != 0u)
        {
            uint32_t red = (source[index] * 255u + alpha / 2u) / alpha;
            uint32_t green = (source[index + 1u] * 255u + alpha / 2u) / alpha;
            uint32_t blue = (source[index + 2u] * 255u + alpha / 2u) / alpha;
            source[index] = (uint8_t)(red > 255u ? 255u : red);
            source[index + 1u] = (uint8_t)(green > 255u ? 255u : green);
            source[index + 2u] = (uint8_t)(blue > 255u ? 255u : blue);
        }
    }
    return source == pixels ? 0 : 1;
}
