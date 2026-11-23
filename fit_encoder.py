import struct
import time
from typing import List, Dict, Any

# Garmin FIT epoch: 1989-12-31 00:00:00 UTC -> Unix timestamp 631065600
FIT_EPOCH_OFFSET = 631065600

CRC_TABLE = (
    0x0000, 0xCC01, 0xD801, 0x1400, 0xF001, 0x3C00, 0x2800, 0xE401,
    0xA001, 0x6C00, 0x7800, 0xB401, 0x5000, 0x9C01, 0x8801, 0x4400,
)


def _fit_crc16(data: bytes) -> int:
    crc = 0
    for byte in data:
        tmp = CRC_TABLE[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ CRC_TABLE[byte & 0xF]

        tmp = CRC_TABLE[crc & 0xF]
        crc = (crc >> 4) & 0x0FFF
        crc = crc ^ tmp ^ CRC_TABLE[(byte >> 4) & 0xF]
    return crc


def _pack_string(text: str, length: int) -> bytes:
    raw = (text or "").encode("utf-8", errors="ignore")[: length - 1]
    return raw.ljust(length, b"\x00")


def _pace_str_to_mms(pace_min: float) -> int:
    """Converts min/km (e.g. 5.0 for 5:00/km) to FIT speed in mm/s."""
    if pace_min <= 0:
        return 0
    sec_per_km = pace_min * 60.0
    m_per_s = 1000.0 / sec_per_km
    return int(round(m_per_s * 1000.0))


def build_garmin_fit_workout(
    workout_name: str,
    sport_type: str,
    steps: List[Dict[str, Any]],
) -> bytes:
    """
    Encodes a structured workout (Carrera or Fuerza) into a binary Garmin .FIT file.
    Pure Python implementation with valid FIT CRC16 checksums.
    """
    records = bytearray()
    fit_ts = int(time.time()) - FIT_EPOCH_OFFSET

    # ── 1. Definition & Data: file_id (Global Msg 0, Local Msg 0) ────────────
    # Fields: type(0,1B,enum=0), manufacturer(1,2B,uint16=0x84), product(2,2B,uint16=0x84),
    #         serial_number(3,4B,uint32z=0x8C), time_created(4,4B,uint32=0x86)
    records += struct.pack(
        "<BBBHB" + "BBB" * 5,
        0x40, 0, 0, 0, 5,  # defn local 0, little endian, msg 0, 5 fields
        0, 1, 0,           # type (enum)
        1, 2, 0x84,        # manufacturer (uint16)
        2, 2, 0x84,        # product (uint16)
        3, 4, 0x8C,        # serial_number (uint32z)
        4, 4, 0x86,        # time_created (uint32)
    )
    records += struct.pack("<BBHHII", 0x00, 5, 1, 1, 1001, fit_ts)  # type=5 (workout)

    # ── 2. Definition & Data: workout (Global Msg 26, Local Msg 1) ───────────
    sport_id = 1 if sport_type == "Carrera" else 10  # 1=running, 10=training
    records += struct.pack(
        "<BBBHB" + "BBB" * 4,
        0x41, 0, 0, 26, 4,  # defn local 1, msg 26, 4 fields
        4, 1, 0,            # sport (enum)
        5, 4, 0x8C,         # capabilities (uint32z)
        6, 2, 0x84,         # num_valid_steps (uint16)
        8, 32, 7,           # wkt_name (string 32B)
    )
    records += struct.pack(
        "<BBIH32s",
        0x01,
        sport_id,
        32,
        len(steps),
        _pack_string(workout_name, 32),
    )

    # ── 3. Definition: workout_step (Global Msg 27, Local Msg 2) ─────────────
    records += struct.pack(
        "<BBBHB" + "BBB" * 8,
        0x42, 0, 0, 27, 8,  # defn local 2, msg 27, 8 fields
        254, 2, 0x84,       # message_index (uint16)
        0, 32, 7,           # wkt_step_name (string 32B)
        1, 1, 0,            # duration_type (enum)
        2, 4, 0x86,         # duration_value (uint32)
        3, 1, 0,            # target_type (enum)
        4, 4, 0x86,         # target_value (uint32)
        5, 4, 0x86,         # custom_target_value_low (uint32)
        6, 4, 0x86,         # custom_target_value_high (uint32)
    )

    for idx, step in enumerate(steps):
        step_name = _pack_string(step.get("name", f"Paso {idx + 1}"), 32)
        dur_type = int(step.get("duration_type", 0))  # 0=time(ms), 29=reps, 5=open
        dur_val = int(step.get("duration_value", 60000))
        tgt_type = int(step.get("target_type", 2))    # 0=speed, 2=open
        tgt_low = int(step.get("target_low", 0))
        tgt_high = int(step.get("target_high", 0))

        records += struct.pack(
            "<BH32sBIBIII",
            0x02,
            idx,
            step_name,
            dur_type,
            dur_val,
            tgt_type,
            0,
            tgt_low,
            tgt_high,
        )

    # ── 4. FIT Header (14 bytes) + Footer CRC (2 bytes) ──────────────────────
    header_12 = struct.pack("<BBHI4s", 14, 0x20, 2132, len(records), b".FIT")
    header_crc = _fit_crc16(header_12)
    header = header_12 + struct.pack("<H", header_crc)

    body = header + bytes(records)
    file_crc = _fit_crc16(body)
    return body + struct.pack("<H", file_crc)
