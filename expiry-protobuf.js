"use strict";

// Minimal protobuf readers for the gexbot payloads carried inside Azure Web
// PubSub's JSON reliable protocol. Keeping these decoders local avoids shipping
// npm dependencies with the desktop companion.
const { zstdDecompressSync } = require("node:zlib");

function readVarint(buffer, start) {
    let value = 0;
    let multiplier = 1;
    let offset = start;
    for (let count = 0; count < 10 && offset < buffer.length; count++) {
        const byte = buffer[offset++];
        value += (byte & 0x7f) * multiplier;
        if ((byte & 0x80) === 0) return { value, offset };
        multiplier *= 128;
    }
    throw new Error("invalid protobuf varint");
}

function parseFields(input) {
    const buffer = Buffer.from(input);
    const fields = new Map();
    let offset = 0;
    while (offset < buffer.length) {
        const tag = readVarint(buffer, offset);
        offset = tag.offset;
        const field = Math.floor(tag.value / 8);
        const wire = tag.value & 7;
        if (!field) throw new Error("invalid protobuf field number");
        let value;
        if (wire === 0) {
            const parsed = readVarint(buffer, offset);
            value = parsed.value;
            offset = parsed.offset;
        } else if (wire === 1) {
            if (offset + 8 > buffer.length) throw new Error("truncated fixed64 field");
            value = buffer.subarray(offset, offset + 8);
            offset += 8;
        } else if (wire === 2) {
            const length = readVarint(buffer, offset);
            offset = length.offset;
            const end = offset + length.value;
            if (end > buffer.length) throw new Error("truncated length-delimited field");
            value = buffer.subarray(offset, end);
            offset = end;
        } else if (wire === 5) {
            if (offset + 4 > buffer.length) throw new Error("truncated fixed32 field");
            value = buffer.subarray(offset, offset + 4);
            offset += 4;
        } else {
            throw new Error(`unsupported protobuf wire type ${wire}`);
        }
        if (!fields.has(field)) fields.set(field, []);
        fields.get(field).push({ wire, value });
    }
    return fields;
}

function firstVarint(fields, field, fallback = 0) {
    const entry = fields.get(field)?.find((item) => item.wire === 0);
    return entry ? entry.value : fallback;
}

function firstBytes(fields, field) {
    return fields.get(field)?.find((item) => item.wire === 2)?.value || null;
}

function repeatedBytes(fields, field) {
    return (fields.get(field) || []).filter((item) => item.wire === 2).map((item) => item.value);
}

function zigzag(value) {
    return value % 2 ? -((value + 1) / 2) : value / 2;
}

function repeatedNumbers(fields, field, signed = false) {
    const result = [];
    for (const item of fields.get(field) || []) {
        if (item.wire === 0) {
            result.push(signed ? zigzag(item.value) : item.value);
        } else if (item.wire === 2) {
            let offset = 0;
            while (offset < item.value.length) {
                const parsed = readVarint(item.value, offset);
                result.push(signed ? zigzag(parsed.value) : parsed.value);
                offset = parsed.offset;
            }
        }
    }
    return result;
}

function text(bytes) {
    return bytes ? Buffer.from(bytes).toString("utf8") : "";
}

function decodeAny(serialized) {
    const fields = parseFields(serialized);
    const value = firstBytes(fields, 2);
    if (!value) throw new Error("protobuf Any did not contain a value");
    return { typeUrl: text(firstBytes(fields, 1)), value };
}

function decodeStrike(serialized) {
    const fields = parseFields(serialized);
    const priors = firstBytes(fields, 4);
    return [
        firstVarint(fields, 1) / 100,
        zigzag(firstVarint(fields, 2)) / 100,
        zigzag(firstVarint(fields, 3)) / 100,
        priors ? repeatedNumbers(parseFields(priors), 1, true).map((value) => value / 100) : [],
    ];
}

function decodeGex(compressed) {
    const fields = parseFields(zstdDecompressSync(compressed));
    return {
        timestamp: firstVarint(fields, 1),
        ticker: text(firstBytes(fields, 2)),
        min_dte: zigzag(firstVarint(fields, 3)),
        sec_min_dte: zigzag(firstVarint(fields, 4, 2)),
        spot: firstVarint(fields, 5) / 100,
        zero_gamma: firstVarint(fields, 6) / 100,
        major_pos_vol: firstVarint(fields, 7) / 100,
        major_pos_oi: firstVarint(fields, 8) / 100,
        major_neg_vol: firstVarint(fields, 9) / 100,
        major_neg_oi: firstVarint(fields, 10) / 100,
        strikes: repeatedBytes(fields, 11).map(decodeStrike),
        sum_gex_vol: zigzag(firstVarint(fields, 12)) / 1000,
        sum_gex_oi: zigzag(firstVarint(fields, 13)) / 1000,
        delta_risk_reversal: zigzag(firstVarint(fields, 14)) / 1000,
    };
}

function decodeMiniContract(serialized) {
    const fields = parseFields(serialized);
    const putPriors = firstBytes(fields, 7);
    return [
        firstVarint(fields, 1) / 100,
        firstVarint(fields, 2) / 1000,
        firstVarint(fields, 3) / 1000,
        zigzag(firstVarint(fields, 4)) / 100,
        repeatedNumbers(fields, 5, true).map((value) => value / 100),
        zigzag(firstVarint(fields, 6)),
        putPriors ? repeatedNumbers(parseFields(putPriors), 1, true) : [],
    ];
}

function decodeGreek(compressed) {
    const fields = parseFields(zstdDecompressSync(compressed));
    return {
        timestamp: firstVarint(fields, 1),
        ticker: text(firstBytes(fields, 2)),
        spot: firstVarint(fields, 3) / 100,
        min_dte: zigzag(firstVarint(fields, 4)),
        sec_min_dte: zigzag(firstVarint(fields, 5, 2)),
        major_positive: firstVarint(fields, 6) / 100,
        major_negative: firstVarint(fields, 7) / 100,
        major_long_gamma: firstVarint(fields, 8) / 100,
        major_short_gamma: firstVarint(fields, 9) / 100,
        mini_contracts: repeatedBytes(fields, 10).map(decodeMiniContract),
    };
}

function parseWebPubSubMessage(rawData) {
    const raw = typeof rawData === "string" ? rawData : Buffer.from(rawData).toString("utf8");
    const message = JSON.parse(raw);
    if (message.type !== "message" || message.from !== "group") {
        return { message, groupData: null };
    }
    if (message.dataType !== "protobuf" || typeof message.data !== "string") {
        throw new Error(`unsupported Web PubSub data type ${message.dataType}`);
    }
    return {
        message,
        groupData: {
            group: String(message.group || ""),
            sequenceId: Number.isSafeInteger(message.sequenceId) ? message.sequenceId : null,
            any: decodeAny(Buffer.from(message.data, "base64")),
        },
    };
}

module.exports = { decodeGex, decodeGreek, parseWebPubSubMessage };
