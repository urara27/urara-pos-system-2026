interface KeypadProps {
  value: string;
  onChange: (value: string) => void;
  maxLength?: number;
  /** 入力欄に伏せ字で出す（PIN 用） */
  masked?: boolean;
  label: string;
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

/** 指で押しやすいテンキー。PIN・番号入力で使う */
export function Keypad({ value, onChange, maxLength = 8, masked = false, label }: KeypadProps) {
  const press = (key: (typeof KEYS)[number]) => {
    if (key === 'clear') onChange('');
    else if (key === 'back') onChange(value.slice(0, -1));
    else if (value.length < maxLength) onChange(value + key);
  };
  return (
    <div className="keypad">
      <div className="keypad__display" aria-label={label}>
        <span className="keypad__label">{label}</span>
        <span className="keypad__value">{masked ? '●'.repeat(value.length) : value || ' '}</span>
      </div>
      <div className="keypad__grid">
        {KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={`keypad__key${key.length > 1 ? ' keypad__key--fn' : ''}`}
            onClick={() => press(key)}
          >
            {key === 'clear' ? 'クリア' : key === 'back' ? '←' : key}
          </button>
        ))}
      </div>
    </div>
  );
}
