"use client";

import { useState, type FormEvent } from "react";

interface InputBarProps {
  onSend: (message: string) => void;
  disabled?: boolean;
}

export function InputBar({ onSend, disabled }: InputBarProps) {
  const [value, setValue] = useState("");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setValue("");
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 border-t p-3">
      <input
        className="flex-1 rounded border px-3 py-2 text-sm"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Type a message..."
        disabled={disabled}
      />
      <button
        type="submit"
        className="rounded bg-blue-600 px-4 py-2 text-sm text-white disabled:opacity-50"
        disabled={disabled}
      >
        Send
      </button>
    </form>
  );
}
