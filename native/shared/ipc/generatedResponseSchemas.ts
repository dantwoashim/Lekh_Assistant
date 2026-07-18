// Generated from lekh-keyboard-protocol.json. Do not edit.
export const IPC_COMMON_DEFINITIONS = {
  "SessionId": {
    "type": "string",
    "minLength": 1,
    "maxLength": 256,
    "x-wellFormedUtf16": true,
    "x-maxUtf16CodeUnits": 256
  },
  "KeyboardMode": {
    "type": "string",
    "enum": [
      "romanized",
      "traditional",
      "romanized-romanized",
      "romanized-traditional",
      "traditional-traditional",
      "traditional-romanized",
      "unicode-proofread",
      "dictionary-lookup",
      "diagnostic"
    ],
    "x-wellFormedUtf16": true
  },
  "SuggestionSurface": {
    "type": "string",
    "enum": [
      "romanized-to-unicode",
      "romanized-to-romanized",
      "romanized-to-unicode-with-labels",
      "traditional-to-unicode",
      "traditional-to-romanized-helper",
      "traditional-to-traditional-proofread"
    ],
    "x-wellFormedUtf16": true
  },
  "TypingContext": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "leftTextWindow",
      "activeDomains",
      "preserveEnglish",
      "secureInput",
      "mode",
      "enabledSurfaces"
    ],
    "properties": {
      "appId": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "appName": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "fieldType": {
        "type": "string",
        "enum": [
          "normal",
          "password",
          "search",
          "code",
          "unknown"
        ],
        "x-wellFormedUtf16": true
      },
      "leftTextWindow": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "rightTextWindow": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "locale": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "activeDomains": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 256,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 256
        }
      },
      "preserveEnglish": {
        "type": "boolean"
      },
      "secureInput": {
        "type": "boolean"
      },
      "mode": {
        "$ref": "#/$defs/KeyboardMode"
      },
      "layoutId": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "enabledSurfaces": {
        "type": "array",
        "maxItems": 6,
        "items": {
          "$ref": "#/$defs/SuggestionSurface"
        }
      },
      "showRomanizedLabels": {
        "type": "boolean"
      },
      "enableNextWordPrediction": {
        "type": "boolean"
      }
    }
  },
  "KeyboardKeyEvent": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "key",
      "code",
      "modifiers",
      "timestamp"
    ],
    "properties": {
      "key": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 256
      },
      "code": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 256
      },
      "modifiers": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "shift",
          "ctrl",
          "alt",
          "meta"
        ],
        "properties": {
          "shift": {
            "type": "boolean"
          },
          "ctrl": {
            "type": "boolean"
          },
          "alt": {
            "type": "boolean"
          },
          "meta": {
            "type": "boolean"
          }
        }
      },
      "isRepeat": {
        "type": "boolean"
      },
      "timestamp": {
        "type": "number",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "platform": {
        "type": "string",
        "enum": [
          "web",
          "windows-tsf",
          "macos-imk",
          "test"
        ],
        "x-wellFormedUtf16": true
      },
      "nativeCode": {
        "oneOf": [
          {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          {
            "type": "string",
            "maxLength": 256,
            "x-wellFormedUtf16": true,
            "x-maxUtf16CodeUnits": 256
          }
        ]
      }
    }
  },
  "Utf16Range": {
    "type": "array",
    "minItems": 2,
    "maxItems": 2,
    "prefixItems": [
      {
        "type": "integer",
        "minimum": 0,
        "maximum": 16384
      },
      {
        "type": "integer",
        "minimum": 0,
        "maximum": 16384
      }
    ],
    "items": false
  },
  "KeyboardHostAction": {
    "type": "string",
    "enum": [
      "passThrough",
      "compose",
      "commit",
      "cancel",
      "errorFallback"
    ],
    "x-wellFormedUtf16": true
  },
  "Candidate": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "id",
      "text",
      "type",
      "confidence",
      "reason"
    ],
    "properties": {
      "id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 256
      },
      "text": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "label": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "type": {
        "type": "string",
        "enum": [
          "word",
          "phrase",
          "completion",
          "correction",
          "dictionary",
          "personal",
          "protected",
          "romanized-helper"
        ],
        "x-wellFormedUtf16": true
      },
      "confidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      },
      "reason": {
        "type": "array",
        "maxItems": 16,
        "items": {
          "type": "string",
          "maxLength": 16384,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 16384
        }
      },
      "shortcut": {
        "type": "string",
        "maxLength": 256,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 256
      },
      "replaceRange": {
        "$ref": "#/$defs/Utf16Range"
      }
    }
  },
  "InlineCompletion": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "text",
      "displayText",
      "contextText",
      "candidate",
      "confidence",
      "source",
      "acceptKeys"
    ],
    "properties": {
      "text": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "displayText": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "contextText": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "candidate": {
        "$ref": "#/$defs/Candidate"
      },
      "confidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      },
      "source": {
        "type": "string",
        "enum": [
          "active-candidate",
          "ngram-lm"
        ],
        "x-wellFormedUtf16": true
      },
      "acceptKeys": {
        "type": "array",
        "minItems": 1,
        "maxItems": 2,
        "uniqueItems": true,
        "items": {
          "type": "string",
          "enum": [
            "Tab",
            "Enter"
          ],
          "x-wellFormedUtf16": true
        }
      }
    }
  },
  "ProofHint": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "range",
      "original",
      "suggestion",
      "type",
      "confidence",
      "action",
      "explanation"
    ],
    "properties": {
      "range": {
        "$ref": "#/$defs/Utf16Range"
      },
      "original": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "suggestion": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "type": {
        "type": "string",
        "enum": [
          "spelling",
          "postposition",
          "normalization",
          "matra",
          "halanta",
          "compound",
          "name-variant",
          "agreement",
          "honorific"
        ],
        "x-wellFormedUtf16": true
      },
      "confidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      },
      "action": {
        "type": "string",
        "enum": [
          "auto-suggest",
          "hint-only",
          "ask"
        ],
        "x-wellFormedUtf16": true
      },
      "explanation": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      }
    }
  },
  "DictionaryResult": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "query",
      "word",
      "confidence"
    ],
    "properties": {
      "query": {
        "type": "string",
        "maxLength": 1024,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 1024
      },
      "word": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "romanized": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 16384,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 16384
        }
      },
      "variants": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 16384,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 16384
        }
      },
      "domains": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 256,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 256
        }
      },
      "source": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "meaning": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "confidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      }
    }
  },
  "CandidateUpdate": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "sessionId",
      "mode",
      "surface",
      "action",
      "compositionText",
      "displayText",
      "caret",
      "candidates",
      "proofHints",
      "shouldShowCandidateUI",
      "confidence",
      "warnings",
      "schemaVersion"
    ],
    "properties": {
      "sessionId": {
        "$ref": "#/$defs/SessionId"
      },
      "mode": {
        "$ref": "#/$defs/KeyboardMode"
      },
      "surface": {
        "$ref": "#/$defs/SuggestionSurface"
      },
      "action": {
        "$ref": "#/$defs/KeyboardHostAction"
      },
      "compositionText": {
        "type": "string",
        "maxLength": 128,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 128
      },
      "displayText": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "caret": {
        "type": "integer",
        "minimum": 0,
        "maximum": 128
      },
      "candidates": {
        "type": "array",
        "maxItems": 8,
        "items": {
          "$ref": "#/$defs/Candidate"
        }
      },
      "primary": {
        "$ref": "#/$defs/Candidate"
      },
      "inlineCompletion": {
        "$ref": "#/$defs/InlineCompletion"
      },
      "proofHints": {
        "type": "array",
        "maxItems": 8,
        "items": {
          "$ref": "#/$defs/ProofHint"
        }
      },
      "committedText": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "consumedRange": {
        "$ref": "#/$defs/Utf16Range"
      },
      "shouldShowCandidateUI": {
        "type": "boolean"
      },
      "confidence": {
        "type": "number",
        "minimum": 0,
        "maximum": 1
      },
      "warnings": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 16384,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 16384
        }
      },
      "latencyMs": {
        "type": "number",
        "minimum": 0
      },
      "schemaVersion": {
        "const": 1
      }
    }
  },
  "CommitResult": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "sessionId",
      "action",
      "committedText",
      "commitEpoch",
      "memoryRecorded",
      "schemaVersion"
    ],
    "properties": {
      "sessionId": {
        "$ref": "#/$defs/SessionId"
      },
      "action": {
        "$ref": "#/$defs/KeyboardHostAction"
      },
      "committedText": {
        "type": "string",
        "maxLength": 16384,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 16384
      },
      "commitEpoch": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "consumedRange": {
        "$ref": "#/$defs/Utf16Range"
      },
      "replacementRange": {
        "$ref": "#/$defs/Utf16Range"
      },
      "followupCandidates": {
        "type": "array",
        "maxItems": 8,
        "items": {
          "$ref": "#/$defs/Candidate"
        }
      },
      "memoryRecorded": {
        "type": "boolean"
      },
      "schemaVersion": {
        "const": 1
      }
    }
  }
} as const;
export const IPC_RESPONSE_PAYLOAD_SCHEMAS = {
  "protocol.negotiate": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "selectedVersion",
      "serverInstanceId",
      "limits"
    ],
    "properties": {
      "selectedVersion": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      },
      "serverInstanceId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 256
      },
      "limits": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "maximumFrameBytes",
          "maximumCompositionLength",
          "hotPathDeadlineMs",
          "maximumPendingRequestsPerConnection",
          "maximumClientInstances",
          "maximumActiveSessions",
          "clientIdleTtlMs"
        ],
        "properties": {
          "maximumFrameBytes": {
            "const": 65536
          },
          "maximumCompositionLength": {
            "const": 128
          },
          "hotPathDeadlineMs": {
            "const": 50
          },
          "maximumPendingRequestsPerConnection": {
            "const": 32
          },
          "maximumClientInstances": {
            "const": 64
          },
          "maximumActiveSessions": {
            "const": 64
          },
          "clientIdleTtlMs": {
            "const": 1800000
          }
        }
      }
    }
  },
  "health.check": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "status",
      "engineReady",
      "warnings"
    ],
    "properties": {
      "status": {
        "type": "string",
        "enum": [
          "ok",
          "degraded"
        ],
        "x-wellFormedUtf16": true
      },
      "daemonVersion": {
        "type": "string",
        "maxLength": 256,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 256
      },
      "engineReady": {
        "type": "boolean"
      },
      "warnings": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 16384,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 16384
        }
      }
    }
  },
  "engine.warm": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ready",
      "partial",
      "loadedModules",
      "unavailableModules",
      "warmTimeMs",
      "warnings"
    ],
    "properties": {
      "ready": {
        "type": "boolean"
      },
      "partial": {
        "type": "boolean"
      },
      "loadedModules": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 256,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 256
        }
      },
      "unavailableModules": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 256,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 256
        }
      },
      "warmTimeMs": {
        "type": "number",
        "minimum": 0
      },
      "warnings": {
        "type": "array",
        "maxItems": 32,
        "items": {
          "type": "string",
          "maxLength": 16384,
          "x-wellFormedUtf16": true,
          "x-maxUtf16CodeUnits": 16384
        }
      }
    }
  },
  "session.begin": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "sessionId",
      "sessionEpoch"
    ],
    "properties": {
      "sessionId": {
        "$ref": "#/$defs/SessionId"
      },
      "sessionEpoch": {
        "type": "integer",
        "minimum": 1,
        "maximum": 9007199254740991
      }
    }
  },
  "session.processKeyStroke": {
    "$ref": "#/$defs/CandidateUpdate"
  },
  "session.updateComposition": {
    "$ref": "#/$defs/CandidateUpdate"
  },
  "session.commitCandidate": {
    "$ref": "#/$defs/CommitResult"
  },
  "session.commitRaw": {
    "$ref": "#/$defs/CommitResult"
  },
  "session.cancel": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "cancelled"
    ],
    "properties": {
      "cancelled": {
        "const": true
      }
    }
  },
  "session.end": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "ended"
    ],
    "properties": {
      "ended": {
        "const": true
      }
    }
  },
  "session.setMode": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "mode"
    ],
    "properties": {
      "mode": {
        "$ref": "#/$defs/KeyboardMode"
      }
    }
  },
  "session.setLayout": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "layoutId"
    ],
    "properties": {
      "layoutId": {
        "type": "string",
        "minLength": 1,
        "maxLength": 256,
        "x-wellFormedUtf16": true,
        "x-maxUtf16CodeUnits": 256
      }
    }
  },
  "suggestions.get": {
    "type": "array",
    "maxItems": 8,
    "items": {
      "$ref": "#/$defs/Candidate"
    }
  },
  "proofHints.get": {
    "type": "array",
    "maxItems": 8,
    "items": {
      "$ref": "#/$defs/ProofHint"
    }
  },
  "dictionary.lookup": {
    "type": "array",
    "maxItems": 8,
    "items": {
      "$ref": "#/$defs/DictionaryResult"
    }
  },
  "memory.learn": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "learned"
    ],
    "properties": {
      "learned": {
        "type": "boolean"
      }
    }
  },
  "diagnostics.getMetrics": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "uptimeMs",
      "activeSessions",
      "warmReady",
      "counters"
    ],
    "properties": {
      "uptimeMs": {
        "type": "number",
        "minimum": 0
      },
      "activeSessions": {
        "type": "integer",
        "minimum": 0,
        "maximum": 9007199254740991
      },
      "warmReady": {
        "type": "boolean"
      },
      "lastError": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "code",
          "message",
          "at"
        ],
        "properties": {
          "code": {
            "type": "string",
            "minLength": 1,
            "maxLength": 256,
            "x-wellFormedUtf16": true,
            "x-maxUtf16CodeUnits": 256
          },
          "message": {
            "type": "string",
            "minLength": 1,
            "maxLength": 16384,
            "x-wellFormedUtf16": true,
            "x-maxUtf16CodeUnits": 16384
          },
          "at": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        }
      },
      "counters": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "processedKeystrokes",
          "ipcTimeouts",
          "passThroughFallbacks",
          "committedCandidates"
        ],
        "properties": {
          "processedKeystrokes": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "ipcTimeouts": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "passThroughFallbacks": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          },
          "committedCandidates": {
            "type": "integer",
            "minimum": 0,
            "maximum": 9007199254740991
          }
        }
      }
    }
  },
  "engine.shutdown": {
    "type": "object",
    "additionalProperties": false,
    "required": [
      "shutdown"
    ],
    "properties": {
      "shutdown": {
        "const": true
      }
    }
  }
} as const;
