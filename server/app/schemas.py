"""
Pydantic Schemas for VisionVault Server (SIH PS 26171)
"""

from typing import Any, Dict, List, Optional
from pydantic import BaseModel, Field


class Mark(BaseModel):
    id: int
    role: Optional[str] = "element"
    box: Optional[Dict[str, Any]] = None
    label: Optional[str] = None


class StepAction(BaseModel):
    type: str  # "click" | "type" | "scroll" | "select" | "press_key" | "done"
    target: Optional[int] = None
    value: Optional[str] = None
    use_vault_field: Optional[str] = None
    reasoning: Optional[str] = None


class StepResponse(BaseModel):
    reasoning: str
    action: StepAction
    # Which tier of the planning chain answered: "gemini" | "groq" | "ollama" | "mock"
    tier: Optional[str] = None


class PageInfo(BaseModel):
    """Non-sensitive page context sent by the extension on every step.

    Deliberately excludes query strings, fragments and page text, so no PII can reach the
    server through this channel. Modelled explicitly so the contract between extension and
    server is enforced by validation.
    """
    title: Optional[str] = None
    url: Optional[str] = None
    url_path: Optional[str] = None
    scroll_y: Optional[float] = None
    page_height: Optional[float] = None
    viewport_height: Optional[float] = None
    viewport_width: Optional[float] = None
    device_pixel_ratio: Optional[float] = None


class TaskHints(BaseModel):
    """What the client already worked out from the user's own instruction."""
    search_query: Optional[str] = None
    site: Optional[str] = None
    open_targets: Optional[List[str]] = None
    from_city: Optional[str] = None
    to_city: Optional[str] = None
    date: Optional[str] = None
    category: Optional[str] = None
    recipient: Optional[str] = None
    message: Optional[str] = None
    wants_shop: Optional[bool] = None
    wants_filter: Optional[bool] = None
    wants_add_to_cart: Optional[bool] = None
    max_price: Optional[float] = None
    min_rating: Optional[float] = None
    wants_best: Optional[bool] = None
    wants_star: Optional[bool] = None
    wants_fork: Optional[bool] = None
    wants_clone: Optional[bool] = None
    wants_issue: Optional[bool] = None
    wants_pr: Optional[bool] = None
    wants_non_stop: Optional[bool] = None
    wants_sort: Optional[bool] = None
    sort: Optional[str] = None


class Progress(BaseModel):
    """What the instruction has achieved so far, as observed by the client."""
    navigated: bool = False
    searched: bool = False
    query_landed: bool = Field(default=False, alias="queryLanded")
    scrolled: bool = False
    filled_any: bool = Field(default=False, alias="filledAny")
    opened: List[str] = []
    from_typed: bool = Field(default=False, alias="fromTyped")
    to_typed: bool = Field(default=False, alias="toTyped")
    booking_step: int = Field(default=0, alias="bookingStep")
    cart_added: bool = Field(default=False, alias="cartAdded")
    product_opened: bool = Field(default=False, alias="productOpened")
    filter_applied: bool = Field(default=False, alias="filterApplied")

    model_config = {"populate_by_name": True, "extra": "ignore"}


class AgentStepRequest(BaseModel):
    redactedImage: Optional[str] = None
    image: Optional[str] = None
    marks: List[Mark] = []
    task: str
    filled_mark_ids: Optional[List[int]] = []
    step: Optional[int] = 1
    page_info: Optional[PageInfo] = None
    task_hints: Optional[TaskHints] = None
    progress: Optional[Progress] = None
