// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app/App";

describe("Minimal typing UI", () => {
  it("renders only the typing box and four mode options", () => {
    render(<App />);

    expect(screen.getByRole("textbox", { name: "Romanized-Traditional" })).toBeInTheDocument();
    expect(screen.getByText("Type naturally.")).toBeInTheDocument();
    expect(screen.getByText("Gray text is the suggestion.")).toBeInTheDocument();
    expect(screen.getByText("Press Tab/Enter or tap Accept.")).toBeInTheDocument();
    expect(screen.getByText("Ctrl+Alt+Space switches mode.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Romanized-Romanized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Romanized-Traditional" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Traditional-Traditional (Beta)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Traditional-Romanized (Beta)" })).toBeInTheDocument();
    expect(screen.queryByText(/Output/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Companion/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Preeti/i)).not.toBeInTheDocument();
  });

  it("accepts Romanized-Traditional suggestions with Tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.type(input, "swasthya karyalaya");

    expectSuggestion("स्वास्थ्य कार्यालय");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("स्वास्थ्य कार्यालय ");
  });

  it("opens the mode shortcut menu and selects a mode by number", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.click(input);
    await user.keyboard("{Control>}{Shift>}m{/Shift}{/Control}");

    expect(screen.getByRole("menu", { name: "Typing mode shortcut menu" })).toBeInTheDocument();
    await user.keyboard("1");
    expect(screen.getByRole("textbox", { name: "Romanized-Romanized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Romanized-Romanized" })).toHaveAttribute("aria-pressed", "true");
  });

  it("opens the mode shortcut menu with the native-style shortcut", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.click(input);
    await user.keyboard("{Control>}{Alt>}[Space]{/Alt}{/Control}");

    expect(screen.getByRole("menu", { name: "Typing mode shortcut menu" })).toBeInTheDocument();
    await user.keyboard("4");
    expect(screen.getByRole("textbox", { name: "Traditional-Romanized (Beta)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Traditional-Romanized (Beta)" })).toHaveAttribute("aria-pressed", "true");
  });

  it("accepts Romanized-Romanized completions with Tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Romanized-Romanized" }));
    const input = screen.getByRole("textbox", { name: "Romanized-Romanized" });
    await user.type(input, "swas");

    expectSuggestion("swasthya");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("swasthya ");
  });

  it("accepts the active suggestion with Enter and keeps typing ready", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.type(input, "ramro x");

    expectSuggestion("राम्रो छ");
    await user.keyboard("{Enter}");
    expect(input).toHaveValue("राम्रो छ ");
    expect(screen.queryByRole("button", { name: /Accept suggestion राम्रो छ/ })).not.toBeInTheDocument();
    await user.type(input, "dherai r");
    expectSuggestion("धेरै राम्रो");
  });

  it("keeps suggestions alive when the user ignores a suggestion and keeps typing", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.type(input, "ramro x");

    expectSuggestion("राम्रो छ");
    await user.type(input, "a dherai r");

    expect(input).toHaveValue("ramro xa dherai r");
    expectSuggestion("धेरै राम्रो");
  });

  it("accepts the active suggestion from the mobile-friendly Accept control", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.type(input, "jilla pra");

    expectSuggestion("जिल्ला प्रशासन");
    await user.click(screen.getByRole("button", { name: /Accept suggestion जिल्ला प्रशासन/ }));
    expect(input).toHaveValue("जिल्ला प्रशासन ");
  });

  it("shows completions immediately for short Romanized prefixes", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Romanized-Romanized" }));
    const input = screen.getByRole("textbox", { name: "Romanized-Romanized" });
    await user.type(input, "k");

    expect(screen.getByText(/^Suggestion: k/i)).toBeInTheDocument();
  });

  it("updates suggestions for the active word inside a Romanized sentence", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.type(input, "mero k");

    expectSuggestion("मेरो के छ अवस्था");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("मेरो के छ अवस्था ");

    await user.click(screen.getByRole("button", { name: "Romanized-Romanized" }));
    const romanizedInput = screen.getByRole("textbox", { name: "Romanized-Romanized" });
    await user.type(romanizedInput, "mero k");

    expectSuggestion("mero ke cha awastha");
    await user.keyboard("{Tab}");
    expect(romanizedInput).toHaveValue("mero ke cha awastha ");
  });

  it("shows casual Romanized suggestions instead of only office/demo words", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.type(input, "kasto c");
    expectSuggestion("कस्तो छ");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("कस्तो छ ");

    await user.click(screen.getByRole("button", { name: "Romanized-Romanized" }));
    const romanizedInput = screen.getByRole("textbox", { name: "Romanized-Romanized" });
    await user.type(romanizedInput, "ramro l");
    expectSuggestion("ramro lagyo");
    await user.keyboard("{Tab}");
    expect(romanizedInput).toHaveValue("ramro lagyo ");
  });

  it("normalizes casual Romanized shorthand in Romanized-Romanized mode", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Romanized-Romanized" }));
    const input = screen.getByRole("textbox", { name: "Romanized-Romanized" });
    await user.type(input, "mero k xa awastha");

    expectSuggestion("mero ke cha awastha");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("mero ke cha awastha ");
  });

  it("offers useful Romanized sentence completions instead of no-op echoes", async () => {
    const user = userEvent.setup();
    render(<App />);

    const defaultInput = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.type(defaultInput, "mero ke cha");
    expectSuggestion("मेरो के छ अवस्था");
    await user.keyboard("{Tab}");
    expect(defaultInput).toHaveValue("मेरो के छ अवस्था ");

    await user.click(screen.getByRole("button", { name: "Romanized-Romanized" }));
    const input = screen.getByRole("textbox", { name: "Romanized-Romanized" });
    await user.type(input, "mero ke cha");

    expectSuggestion("mero ke cha awastha");
    expect(screen.queryByText("Suggestion: mero ke cha")).not.toBeInTheDocument();
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("mero ke cha awastha ");
  });

  it("suggests only for the active segment inside long casual and official text", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    const casualPrefix = "namaste mero naam prabin ho. ma bholi office jane ho.\n";
    await user.type(input, `${casualPrefix}swasthya k`);
    expectSuggestion("स्वास्थ्य कार्यालय");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue(`${casualPrefix}स्वास्थ्य कार्यालय `);

    await user.clear(input);
    const officialPrefix = "mero NID form submit bhayena. kripaya yo file heridinu.\n";
    await user.type(input, `${officialPrefix}jilla pra`);
    expectSuggestion("जिल्ला प्रशासन");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue(`${officialPrefix}जिल्ला प्रशासन `);

    await user.click(screen.getByRole("button", { name: "Romanized-Romanized" }));
    const romanizedInput = screen.getByRole("textbox", { name: "Romanized-Romanized" });
    const messagePrefix = "hey sathi, k gardai chau?\n";
    await user.type(romanizedInput, `${messagePrefix}mero ke cha`);
    expectSuggestion("mero ke cha awastha");
    await user.keyboard("{Tab}");
    expect(romanizedInput).toHaveValue(`${messagePrefix}mero ke cha awastha `);
  });

  it("keeps the visible suggestion lane populated for rare Romanized prefixes", async () => {
    const user = userEvent.setup();
    render(<App />);

    const input = screen.getByRole("textbox", { name: "Romanized-Traditional" });
    await user.type(input, "z");

    expect(screen.getByText(/^Suggestion:/)).toBeInTheDocument();
  });

  it("accepts Traditional-Traditional suggestions with Tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Traditional-Traditional (Beta)" }));
    const input = screen.getByRole("textbox", { name: "Traditional-Traditional (Beta)" });
    await user.type(input, "स्वा");

    expectSuggestion("स्वास्थ्य");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("स्वास्थ्य ");
  });

  it("accepts Traditional-Romanized suggestions with Tab", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole("button", { name: "Traditional-Romanized (Beta)" }));
    const input = screen.getByRole("textbox", { name: "Traditional-Romanized (Beta)" });
    await user.type(input, "स्वास्थ्य");

    expectSuggestion("swasthya");
    await user.keyboard("{Tab}");
    expect(input).toHaveValue("swasthya ");
  });
});

function expectSuggestion(text: string) {
  expect(screen.getByText(`Suggestion: ${text}`)).toBeInTheDocument();
}
