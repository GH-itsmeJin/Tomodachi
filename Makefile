COMPOSE ?= docker compose

.PHONY: up down

up:
	$(COMPOSE) up --build -d

down:
	$(COMPOSE) down
