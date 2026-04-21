import json
import math
from pathlib import Path


ROOT_DIR = Path(r"C:\Users\sandr\OneDrive\Documents\Robo-Doge")
CONFIG_FILE = ROOT_DIR / "config" / "dogzilla-proxy-walk-cycle.json"
OUTPUT_FILE = ROOT_DIR / "isaacsim" / "dogzilla_proxy_blockout_walk.usda"

LEG_MAP = {
    "front_left": ("front_left_hip", "front_left_upper", "front_left_lower", "front"),
    "front_right": ("front_right_hip", "front_right_upper", "front_right_lower", "front"),
    "rear_left": ("rear_left_hip", "rear_left_upper", "rear_left_lower", "rear"),
    "rear_right": ("rear_right_hip", "rear_right_upper", "rear_right_lower", "rear"),
}


def format_float(value):
    text = f"{value:.6f}".rstrip("0").rstrip(".")
    if text == "-0":
        return "0"
    if "." not in text:
        return f"{text}.0"
    return text


def format_tuple(values):
    return "(" + ", ".join(format_float(value) for value in values) + ")"


def build_samples(start, end, step, compute_value):
    samples = []
    frame = start
    while frame <= end:
        samples.append((frame, compute_value(frame)))
        frame += step
    if samples[-1][0] != end:
        samples.append((end, compute_value(end)))
    return samples


def sample_to_lines(samples, indent):
    lines = [indent + "{"] 
    for frame, value in samples:
        if isinstance(value, tuple):
            rendered = format_tuple(value)
        else:
            rendered = format_float(value)
        lines.append(f"{indent}    {frame}: {rendered},")
    if len(lines) > 1:
        lines[-1] = lines[-1].rstrip(",")
    lines.append(indent + "}")
    return lines


def main():
    config = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    start = int(config["startTimeCode"])
    end = int(config["endTimeCode"])
    step = int(config["sampleStep"])
    tps = int(config["timeCodesPerSecond"])

    defaults = config["defaults"]
    amplitudes = config["amplitudes"]

    def phase_at(frame, offset):
        base = (frame - start) / (end - start)
        return (base + offset) % 1.0

    def gait_values(frame, leg_name, side):
        phase = phase_at(frame, config["gait"]["phaseOffsets"][leg_name])
        swing = math.sin(phase * math.tau)
        lift = max(0.0, math.sin(phase * math.tau))

        if side == "front":
            hip = defaults["frontHip"] + amplitudes["hipSwing"] * swing
            upper = defaults["frontUpper"] + amplitudes["upperSwing"] * swing - amplitudes["upperLift"] * lift
            lower = defaults["frontLower"] - amplitudes["lowerSwing"] * swing + amplitudes["lowerLift"] * lift
        else:
            hip = defaults["rearHip"] - amplitudes["hipSwing"] * swing
            upper = defaults["rearUpper"] - amplitudes["upperSwing"] * swing + amplitudes["upperLift"] * lift
            lower = defaults["rearLower"] + amplitudes["lowerSwing"] * swing - amplitudes["lowerLift"] * lift

        return hip, upper, lower

    def body_translate(frame):
        base = tuple(config["body"]["baseTranslate"])
        bob = config["body"]["bobAmplitude"] * math.cos(((frame - start) / (end - start)) * math.tau * 2)
        return (base[0], base[1], base[2] + bob)

    lines = [
        "#usda 1.0",
        "(",
        '    defaultPrim = "World"',
        f"    startTimeCode = {start}",
        f"    endTimeCode = {end}",
        f"    timeCodesPerSecond = {tps}",
        "    metersPerUnit = 1",
        "    subLayers = [",
        "        @./dogzilla_proxy_blockout.usda@",
        "    ]",
        '    upAxis = "Z"',
        ")",
        "",
        'over "World"',
        "{",
        '    over "DOGZILLA_PROXY"',
        "    {",
        '        over "body_link"',
        "        {",
    ]

    body_lines = sample_to_lines(build_samples(start, end, step, body_translate), "                ")
    body_lines[0] = "            double3 xformOp:translate.timeSamples = " + body_lines[0].strip()
    lines.extend(body_lines)
    lines.extend([
        "",
    ])

    for leg_name, (hip_name, upper_name, lower_name, side) in LEG_MAP.items():
        hip_samples = build_samples(start, end, step, lambda frame, ln=leg_name, sd=side: gait_values(frame, ln, sd)[0])
        upper_samples = build_samples(start, end, step, lambda frame, ln=leg_name, sd=side: gait_values(frame, ln, sd)[1])
        lower_samples = build_samples(start, end, step, lambda frame, ln=leg_name, sd=side: gait_values(frame, ln, sd)[2])

        hip_lines = sample_to_lines(hip_samples, "                    ")
        upper_lines = sample_to_lines(upper_samples, "                        ")
        lower_lines = sample_to_lines(lower_samples, "                            ")
        hip_lines[0] = "                double xformOp:rotateX.timeSamples = " + hip_lines[0].strip()
        upper_lines[0] = "                    double xformOp:rotateX.timeSamples = " + upper_lines[0].strip()
        lower_lines[0] = "                        double xformOp:rotateX.timeSamples = " + lower_lines[0].strip()

        lines.extend([
            f'            over "{hip_name}"',
            "            {",
            *hip_lines,
            f'                over "{upper_name}"',
            "                {",
            *upper_lines,
            f'                    over "{lower_name}"',
            "                    {",
            *lower_lines,
            "                    }",
            "                }",
            "            }",
            "",
        ])

    lines.extend([
        "        }",
        "    }",
        "}",
        "",
    ])

    OUTPUT_FILE.write_text("\n".join(lines), encoding="utf-8")
    print(f"Wrote walk cycle scene: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
