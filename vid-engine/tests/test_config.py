from src.config import load_config


def test_compatible_model_can_omit_reasoning_parameter(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gpt")
    monkeypatch.setenv("GPT_REASONING_EFFORT", "omit")
    assert load_config().llm_reasoning_effort == ""


def test_none_reasoning_is_preserved_for_services_that_support_it(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gpt")
    monkeypatch.setenv("GPT_REASONING_EFFORT", "none")
    assert load_config().llm_reasoning_effort == "none"


def test_deepseek_does_not_inherit_other_provider_reasoning(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "deepseek")
    monkeypatch.setenv("GPT_REASONING_EFFORT", "high")
    assert load_config().llm_reasoning_effort == ""
