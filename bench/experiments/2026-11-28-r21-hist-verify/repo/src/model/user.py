class User:
    def __init__(self, user_id, name, email):
        self.user_id = user_id
        self.name = name
        self.email = email

    def display(self):
        return f"{self.name} <{self.email}>"
