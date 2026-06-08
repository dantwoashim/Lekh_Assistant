import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { App } from "../app/App";

describe("App", () => {
  it("renders the Preeti converter as the primary tab", async () => {
    render(<App />);
    expect(screen.getByRole("tab", { name: /preeti/i })).toHaveAttribute("aria-selected", "true");
    expect(await screen.findByLabelText(/Preeti text/i, {}, { timeout: 8000 })).toBeInTheDocument();
    expect(await screen.findByDisplayValue("नमस्ते", {}, { timeout: 8000 })).toBeInTheDocument();
  });

  it("renders Romanized editor and suggestions", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: /^Romanized$/i }));
    expect(await screen.findByLabelText(/Romanized input/i)).toBeInTheDocument();
    expect(await screen.findByDisplayValue(/NID form को नाम field/)).toBeInTheDocument();
  });

  it("applies a suggestion by replacing only the current romanized token", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: /^Romanized$/i }));
    const input = await screen.findByLabelText(/Romanized input/i);
    await user.clear(input);
    await user.type(input, "mero pra");
    const [suggestion] = await screen.findAllByRole("button", { name: /प्रशासन/i });
    await user.click(suggestion);
    expect(input).toHaveValue("mero prashasan");
    expect(screen.getByDisplayValue("मेरो प्रशासन")).toBeInTheDocument();
  });

  it("applies romanized candidates as full-output alternatives", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: /^Romanized$/i }));
    const input = await screen.findByLabelText(/Romanized input/i);
    await user.clear(input);
    await user.type(input, "niraj bhusal");
    await user.click(screen.getByRole("button", { name: /नीरज भुसाल/i }));

    expect(screen.getByDisplayValue("नीरज भुसाल")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("नीरज")).not.toBeInTheDocument();
  });

  it("updates the feedback draft with the latest reported tool output", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: /^Romanized$/i }));
    const input = await screen.findByLabelText(/Romanized input/i);
    await user.clear(input);
    await user.type(input, "Thapa");
    await user.click(screen.getByRole("button", { name: /report bad typing/i }));

    expect(screen.getByLabelText(/Actual output/i)).toHaveValue("थापा");
  });

  it("renders Traditional reference without creating a typing engine", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: /^Traditional$/i }));
    expect(await screen.findByText(/not a full Traditional key map/i)).toBeInTheDocument();
    expect(await screen.findByText("क्ष")).toBeInTheDocument();
  });

  it("renders Keyboard Lab with session candidates and warnings", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: /Keyboard Lab/i }));
    expect(await screen.findByText("Keyboard Lab")).toBeInTheDocument();
    expect((await screen.findAllByText("स्वास्थ्य कार्यालय")).length).toBeGreaterThan(0);
    expect(await screen.findByText("Dictionary")).toBeInTheDocument();
    expect((await screen.findAllByText("स्वास्थ्य")).length).toBeGreaterThan(0);
    await user.click(screen.getByLabelText(/Romanized labels/i));
    expect((await screen.findAllByText("swasthya karyalaya")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: /^Traditional$/i }));
    expect(await screen.findByText(/Traditional layout mapping pending/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Proofread$/i }));
    const composition = await screen.findByLabelText(/Active composition/i);
    await user.clear(composition);
    await user.type(composition, "विद्यालय को");
    expect(await screen.findByText(/विद्यालय को → विद्यालयको/i)).toBeInTheDocument();
  });

  it("renders the companion production shell without pretending it is an IME", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: /^Companion$/i }));
    expect(await screen.findByText("Production Pages")).toBeInTheDocument();
    expect(await screen.findByText(/Dev daemon/i)).toBeInTheDocument();
    expect(await screen.findByText(/No global key hook in the companion/i)).toBeInTheDocument();
    expect(await screen.findByText("Privacy Page Ready")).toBeInTheDocument();
    expect((await screen.findAllByText(/redacted diagnostics/i)).length).toBeGreaterThan(0);
    expect(await screen.findByText(/Companion app controls settings and diagnostics/i)).toBeInTheDocument();
    expect((await screen.findAllByText("Privacy")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("blocked-human")).length).toBeGreaterThan(0);
  });
});
